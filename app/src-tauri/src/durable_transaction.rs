use std::fs::File;
use std::io;
use std::path::{Component, Path, PathBuf};

const LOCK_NAME: &str = ".studio-durable-v1.lock";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DurableTransactionError {
    Unavailable,
    PersistenceOutcomeUnknown,
}

pub(crate) struct DurableTransaction {
    namespace: Option<TransactionNamespace>,
    expected_lock_identity: Option<FileIdentity>,
}

impl DurableTransaction {
    pub(crate) fn new(root: &Path) -> Self {
        let provisioned = TransactionNamespace::confine(root).and_then(|namespace| {
            namespace.revalidate()?;
            let lock = namespace.open_lock(true)?;
            let identity = opened_identity(&lock)?;
            namespace.validate_lock(&lock, identity)?;
            Ok((namespace, identity))
        });
        match provisioned {
            Ok((namespace, identity)) => Self {
                namespace: Some(namespace),
                expected_lock_identity: Some(identity),
            },
            Err(_) => Self {
                namespace: None,
                expected_lock_identity: None,
            },
        }
    }

    pub(crate) fn with_lock<T>(
        &self,
        operation: impl FnOnce() -> T,
    ) -> Result<T, DurableTransactionError> {
        let namespace = self
            .namespace
            .as_ref()
            .ok_or(DurableTransactionError::Unavailable)?;
        let expected = self
            .expected_lock_identity
            .ok_or(DurableTransactionError::Unavailable)?;
        namespace
            .revalidate()
            .map_err(|_| DurableTransactionError::Unavailable)?;
        let file = namespace
            .open_lock(false)
            .map_err(|_| DurableTransactionError::Unavailable)?;
        if opened_identity(&file).ok() != Some(expected) {
            return Err(DurableTransactionError::Unavailable);
        }
        let lock =
            TransactionFileLock::acquire(file).map_err(|_| DurableTransactionError::Unavailable)?;
        namespace
            .validate_lock(lock.file(), expected)
            .map_err(|_| DurableTransactionError::Unavailable)?;

        let value = operation();

        if namespace.validate_lock(lock.file(), expected).is_err() {
            return Err(DurableTransactionError::PersistenceOutcomeUnknown);
        }
        Ok(value)
    }
}

fn validate_root_path(root: &Path) -> io::Result<()> {
    if !root.is_absolute()
        || root
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "durable transaction root is not an exact absolute path",
        ));
    }
    Ok(())
}

#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileIdentity {
    volume: u32,
    file: u64,
}

#[cfg(unix)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileIdentity {
    device: u64,
    inode: u64,
}

#[cfg(windows)]
fn opened_identity(file: &File) -> io::Result<FileIdentity> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(FileIdentity {
        volume: information.dwVolumeSerialNumber,
        file: (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow),
    })
}

#[cfg(unix)]
fn opened_identity(file: &File) -> io::Result<FileIdentity> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    Ok(FileIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

#[cfg(windows)]
fn opened_is_reparse(file: &File) -> io::Result<bool> {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
    Ok(file.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
}

#[cfg(windows)]
fn open_directory_no_follow(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

#[cfg(windows)]
struct DirectoryGuard {
    path: PathBuf,
    file: File,
    identity: FileIdentity,
}

#[cfg(windows)]
struct TransactionNamespace {
    guards: Vec<DirectoryGuard>,
}

#[cfg(windows)]
impl TransactionNamespace {
    fn confine(root: &Path) -> io::Result<Self> {
        validate_root_path(root)?;
        let mut ancestors = root
            .ancestors()
            .filter(|ancestor| !ancestor.as_os_str().is_empty())
            .map(Path::to_path_buf)
            .collect::<Vec<_>>();
        ancestors.reverse();
        let mut guards = Vec::with_capacity(ancestors.len());
        for path in ancestors {
            let file = open_directory_no_follow(&path)?;
            if !file.metadata()?.is_dir() || opened_is_reparse(&file)? {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "durable transaction root has a reparse ancestor",
                ));
            }
            let identity = opened_identity(&file)?;
            guards.push(DirectoryGuard {
                path,
                file,
                identity,
            });
        }
        let namespace = Self { guards };
        namespace.revalidate()?;
        Ok(namespace)
    }

    fn root(&self) -> io::Result<&DirectoryGuard> {
        self.guards.last().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "durable transaction root is unavailable",
            )
        })
    }

    fn revalidate(&self) -> io::Result<()> {
        for guard in &self.guards {
            if opened_identity(&guard.file)? != guard.identity
                || opened_is_reparse(&guard.file)?
                || !guard.file.metadata()?.is_dir()
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "durable transaction root handle changed",
                ));
            }
            let current = open_directory_no_follow(&guard.path)?;
            if opened_identity(&current)? != guard.identity
                || opened_is_reparse(&current)?
                || !current.metadata()?.is_dir()
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "durable transaction root namespace changed",
                ));
            }
        }
        Ok(())
    }

    fn open_lock(&self, create: bool) -> io::Result<File> {
        use std::os::windows::ffi::OsStrExt;
        use std::os::windows::io::{AsRawHandle, FromRawHandle};
        use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;
        use windows_sys::Wdk::Storage::FileSystem::{
            NtCreateFile, FILE_NON_DIRECTORY_FILE, FILE_OPEN, FILE_OPEN_IF,
            FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT,
        };
        use windows_sys::Win32::Foundation::{
            RtlNtStatusToDosError, HANDLE, OBJ_CASE_INSENSITIVE, UNICODE_STRING,
        };
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_DELETE,
            FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;

        let root = self.root()?;
        let mut name = std::ffi::OsStr::new(LOCK_NAME)
            .encode_wide()
            .collect::<Vec<_>>();
        let length = u16::try_from(name.len().saturating_mul(2))
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "lock name is too long"))?;
        let unicode = UNICODE_STRING {
            Length: length,
            MaximumLength: length,
            Buffer: name.as_mut_ptr(),
        };
        let attributes = OBJECT_ATTRIBUTES {
            Length: u32::try_from(std::mem::size_of::<OBJECT_ATTRIBUTES>())
                .expect("OBJECT_ATTRIBUTES size fits in u32"),
            RootDirectory: root.file.as_raw_handle(),
            ObjectName: &unicode,
            Attributes: OBJ_CASE_INSENSITIVE,
            SecurityDescriptor: std::ptr::null(),
            SecurityQualityOfService: std::ptr::null(),
        };
        let mut handle: HANDLE = std::ptr::null_mut();
        let mut status_block = IO_STATUS_BLOCK::default();
        let status = unsafe {
            NtCreateFile(
                &mut handle,
                FILE_GENERIC_READ | FILE_GENERIC_WRITE,
                &attributes,
                &mut status_block,
                std::ptr::null(),
                FILE_ATTRIBUTE_NORMAL,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                if create { FILE_OPEN_IF } else { FILE_OPEN },
                FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
                std::ptr::null(),
                0,
            )
        };
        if status < 0 {
            return Err(io::Error::from_raw_os_error(
                unsafe { RtlNtStatusToDosError(status) } as i32,
            ));
        }
        let file = unsafe { File::from_raw_handle(handle) };
        if !file.metadata()?.is_file() || opened_is_reparse(&file)? {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "durable transaction lock is not a direct regular file",
            ));
        }
        Ok(file)
    }

    fn validate_lock(&self, opened: &File, expected: FileIdentity) -> io::Result<()> {
        self.revalidate()?;
        if opened_identity(opened)? != expected || opened_is_reparse(opened)? {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "durable transaction lock handle changed",
            ));
        }
        let current = self.open_lock(false)?;
        if opened_identity(&current)? != expected || opened_is_reparse(&current)? {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "durable transaction lock namespace changed",
            ));
        }
        Ok(())
    }
}

#[cfg(unix)]
struct DirectoryGuard {
    path: PathBuf,
    file: File,
    identity: FileIdentity,
}

#[cfg(unix)]
struct TransactionNamespace {
    guards: Vec<DirectoryGuard>,
}

#[cfg(unix)]
impl TransactionNamespace {
    fn confine(root: &Path) -> io::Result<Self> {
        use std::os::unix::fs::OpenOptionsExt;
        validate_root_path(root)?;
        let mut ancestors = root
            .ancestors()
            .filter(|ancestor| !ancestor.as_os_str().is_empty())
            .map(Path::to_path_buf)
            .collect::<Vec<_>>();
        ancestors.reverse();
        let mut guards = Vec::with_capacity(ancestors.len());
        for path in ancestors {
            let file = std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW)
                .open(&path)?;
            if !file.metadata()?.is_dir() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "durable transaction root has a symlink ancestor",
                ));
            }
            let identity = opened_identity(&file)?;
            guards.push(DirectoryGuard {
                path,
                file,
                identity,
            });
        }
        let namespace = Self { guards };
        namespace.revalidate()?;
        Ok(namespace)
    }

    fn root(&self) -> io::Result<&DirectoryGuard> {
        self.guards.last().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "durable transaction root is unavailable",
            )
        })
    }

    fn revalidate(&self) -> io::Result<()> {
        use std::os::unix::fs::MetadataExt;
        for guard in &self.guards {
            if opened_identity(&guard.file)? != guard.identity || !guard.file.metadata()?.is_dir() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "durable transaction root handle changed",
                ));
            }
            let current = std::fs::symlink_metadata(&guard.path)?;
            if !current.is_dir()
                || current.file_type().is_symlink()
                || current.dev() != guard.identity.device
                || current.ino() != guard.identity.inode
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "durable transaction root namespace changed",
                ));
            }
        }
        Ok(())
    }

    fn open_lock(&self, create: bool) -> io::Result<File> {
        use std::os::fd::{AsRawFd, FromRawFd};
        let name = std::ffi::CString::new(LOCK_NAME).expect("lock name has no NUL");
        let mut flags = libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_RDWR;
        if create {
            flags |= libc::O_CREAT;
        }
        let descriptor =
            unsafe { libc::openat(self.root()?.file.as_raw_fd(), name.as_ptr(), flags, 0o600) };
        if descriptor < 0 {
            return Err(io::Error::last_os_error());
        }
        let file = unsafe { File::from_raw_fd(descriptor) };
        if !file.metadata()?.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "durable transaction lock is not a direct regular file",
            ));
        }
        Ok(file)
    }

    fn validate_lock(&self, opened: &File, expected: FileIdentity) -> io::Result<()> {
        self.revalidate()?;
        if opened_identity(opened)? != expected {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "durable transaction lock handle changed",
            ));
        }
        let current = self.open_lock(false)?;
        if opened_identity(&current)? != expected {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "durable transaction lock namespace changed",
            ));
        }
        Ok(())
    }
}

#[cfg(windows)]
struct TransactionFileLock {
    file: File,
}

#[cfg(windows)]
impl TransactionFileLock {
    fn acquire(file: File) -> io::Result<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::LockFile;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            if unsafe { LockFile(file.as_raw_handle(), 0, 0, 1, 0) } != 0 {
                return Ok(Self { file });
            }
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(33) || std::time::Instant::now() >= deadline {
                return Err(error);
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    fn file(&self) -> &File {
        &self.file
    }
}

#[cfg(windows)]
impl Drop for TransactionFileLock {
    fn drop(&mut self) {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::UnlockFile;
        unsafe {
            UnlockFile(self.file.as_raw_handle(), 0, 0, 1, 0);
        }
    }
}

#[cfg(unix)]
struct TransactionFileLock {
    file: File,
}

#[cfg(unix)]
impl TransactionFileLock {
    fn acquire(file: File) -> io::Result<Self> {
        use std::os::fd::AsRawFd;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { file })
    }

    fn file(&self) -> &File {
        &self.file
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
