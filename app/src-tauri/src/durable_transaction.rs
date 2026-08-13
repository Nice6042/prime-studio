use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};

const LOCK_NAME: &str = ".studio-durable-v1.lock";

pub(crate) struct DurableTransaction {
    path: PathBuf,
    provisioned: bool,
}

impl DurableTransaction {
    pub(crate) fn new(root: &Path) -> Self {
        let path = root.join(LOCK_NAME);
        let provisioned = root.is_absolute() && TransactionFileLock::provision(&path).is_ok();
        Self { path, provisioned }
    }

    pub(crate) fn acquire(&self) -> Result<TransactionFileLock, &'static str> {
        if !self.provisioned {
            return Err("durable transaction lock is unavailable");
        }
        TransactionFileLock::acquire(&self.path)
            .map_err(|_| "durable transaction lock is unavailable")
    }
}

#[cfg(windows)]
pub(crate) struct TransactionFileLock {
    file: File,
}

#[cfg(windows)]
impl TransactionFileLock {
    fn open(path: &Path, create: bool) -> std::io::Result<File> {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
            FILE_SHARE_WRITE,
        };
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(create)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        use std::os::windows::fs::MetadataExt;
        if file.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "transaction lock is a reparse point",
            ));
        }
        Ok(file)
    }
    fn provision(path: &Path) -> std::io::Result<()> {
        drop(Self::open(path, true)?);
        Ok(())
    }
    fn acquire(path: &Path) -> std::io::Result<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::LockFile;
        let file = Self::open(path, false)?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            if unsafe { LockFile(file.as_raw_handle() as _, 0, 0, 1, 0) } != 0 {
                return Ok(Self { file });
            }
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(33) || std::time::Instant::now() >= deadline {
                return Err(error);
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
}

#[cfg(windows)]
impl Drop for TransactionFileLock {
    fn drop(&mut self) {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::UnlockFile;
        unsafe {
            UnlockFile(self.file.as_raw_handle() as _, 0, 0, 1, 0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::DurableTransaction;
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;
    use std::time::{Duration, Instant};

    const CHILD_ROOT: &str = "PRIME_DURABLE_TRANSACTION_CHILD_ROOT";
    const CHILD_READY: &str = "PRIME_DURABLE_TRANSACTION_CHILD_READY";
    const CHILD_RELEASE: &str = "PRIME_DURABLE_TRANSACTION_CHILD_RELEASE";

    #[test]
    fn durable_transaction_process_child() {
        let Some(root) = std::env::var_os(CHILD_ROOT).map(PathBuf::from) else {
            return;
        };
        let ready = PathBuf::from(std::env::var_os(CHILD_READY).expect("child ready path"));
        let release = PathBuf::from(std::env::var_os(CHILD_RELEASE).expect("child release path"));
        let transaction = DurableTransaction::new(&root);
        let lock = transaction.acquire().expect("child acquires process lock");
        fs::write(&ready, b"ready").unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !release.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(release.exists(), "parent releases child process lock");
        drop(lock);
    }

    #[test]
    fn independent_processes_serialize_on_the_same_durable_transaction_file() {
        let root = std::env::temp_dir().join(format!(
            "prime-studio-durable-transaction-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&root).unwrap();
        let ready = root.join("ready");
        let release = root.join("release");
        let acquired = root.join("acquired");
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("durable_transaction::tests::durable_transaction_process_child")
            .arg("--test-threads=1")
            .env(CHILD_ROOT, &root)
            .env(CHILD_READY, &ready)
            .env(CHILD_RELEASE, &release)
            .spawn()
            .expect("start lock-holder process");
        let deadline = Instant::now() + Duration::from_secs(10);
        while !ready.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(ready.exists(), "child reaches locked state");

        let contender_root = root.clone();
        let contender = std::thread::spawn(move || {
            let transaction = DurableTransaction::new(&contender_root);
            let _lock = transaction
                .acquire()
                .expect("contender acquires after release");
            fs::write(acquired, b"acquired").unwrap();
        });
        std::thread::sleep(Duration::from_millis(200));
        assert!(!root.join("acquired").exists(), "contender remains blocked");
        fs::write(&release, b"release").unwrap();
        assert!(child.wait().unwrap().success());
        contender.join().unwrap();
        assert!(root.join("acquired").exists());
        let _ = fs::remove_dir_all(root);
    }
}

#[cfg(unix)]
pub(crate) struct TransactionFileLock {
    file: File,
}

#[cfg(unix)]
impl TransactionFileLock {
    fn open(path: &Path, create: bool) -> std::io::Result<File> {
        use std::os::unix::fs::OpenOptionsExt;
        OpenOptions::new()
            .read(true)
            .write(true)
            .create(create)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)
    }
    fn provision(path: &Path) -> std::io::Result<()> {
        drop(Self::open(path, true)?);
        Ok(())
    }
    fn acquire(path: &Path) -> std::io::Result<Self> {
        use std::os::fd::AsRawFd;
        let file = Self::open(path, false)?;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(Self { file })
    }
}

#[cfg(unix)]
impl Drop for TransactionFileLock {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        unsafe {
            libc::flock(self.file.as_raw_fd(), libc::LOCK_UN);
        }
    }
}
