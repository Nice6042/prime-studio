pub mod delete;
pub mod recovery;

use std::collections::BTreeSet;
#[cfg(unix)]
use std::fs::File;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

use serde::de::{self, DeserializeSeed, Error as _, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use unicode_general_category::{get_general_category, GeneralCategory};

use crate::bounded_io::read_bounded;

static NEXT_TEMP_FILE: AtomicU64 = AtomicU64::new(1);

pub(crate) const MAX_PROVIDER_PRODUCT_PROVIDERS: usize = 64;
pub(crate) const MAX_PROVIDER_PRODUCT_ACCOUNTS: usize = 256;
pub(crate) const MAX_PROVIDER_PRODUCT_PROVIDER_ID_UTF8_BYTES: usize = 56;
pub(crate) const MAX_PROVIDER_PRODUCT_PROVIDER_ID_SCALARS: usize = 56;
pub(crate) const MAX_PROVIDER_PRODUCT_ACCOUNT_ID_UTF8_BYTES: usize = 64;
pub(crate) const MAX_PROVIDER_PRODUCT_ACCOUNT_ID_SCALARS: usize = 64;
pub(crate) const MAX_PROVIDER_PRODUCT_DISPLAY_NAME_UTF8_BYTES: usize = 256;
pub(crate) const MAX_PROVIDER_PRODUCT_DISPLAY_NAME_SCALARS: usize = 128;
pub(crate) const MAX_ACCOUNT_REGISTRY_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const MAX_AUTH_FILE_BYTES: usize = 4 * 1024 * 1024;
const MAX_ACCOUNT_AGENT_DIR_UTF8_BYTES: usize = 4 * 1024;
const MAX_ACCOUNT_AGENT_DIR_SCALARS: usize = 4 * 1024;

fn bounded_string(value: &str, max_utf8_bytes: usize, max_scalars: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_utf8_bytes
        && value.chars().take(max_scalars + 1).count() <= max_scalars
}

/// Lossless provider migration grammar. IDs are 1-56 lowercase ASCII
/// letters/digits with hyphens only internally. The ceiling leaves room for
/// `default-` inside the existing 64-byte account-ID boundary.
pub(crate) fn valid_provider_product_provider_id(provider_id: &str) -> bool {
    if !bounded_string(
        provider_id,
        MAX_PROVIDER_PRODUCT_PROVIDER_ID_UTF8_BYTES,
        MAX_PROVIDER_PRODUCT_PROVIDER_ID_SCALARS,
    ) {
        return false;
    }
    let bytes = provider_id.as_bytes();
    bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        && bytes.last().is_some_and(u8::is_ascii_alphanumeric)
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

pub(crate) fn valid_provider_product_account_id(account_id: &str) -> bool {
    bounded_string(
        account_id,
        MAX_PROVIDER_PRODUCT_ACCOUNT_ID_UTF8_BYTES,
        MAX_PROVIDER_PRODUCT_ACCOUNT_ID_SCALARS,
    ) && delete::valid_account_id(account_id)
}

pub(crate) fn valid_provider_product_display_name(display_name: &str) -> bool {
    if !bounded_string(
        display_name,
        MAX_PROVIDER_PRODUCT_DISPLAY_NAME_UTF8_BYTES,
        MAX_PROVIDER_PRODUCT_DISPLAY_NAME_SCALARS,
    ) || display_name.trim().is_empty()
    {
        return false;
    }
    !display_name.chars().any(|character| {
        matches!(
            get_general_category(character),
            GeneralCategory::Control
                | GeneralCategory::Format
                | GeneralCategory::LineSeparator
                | GeneralCategory::ParagraphSeparator
                | GeneralCategory::Surrogate
        )
    })
}

fn legacy_emoji_joiner_has_symbol_neighbors(characters: &[char], index: usize) -> bool {
    fn neighboring_symbol<'a>(characters: impl Iterator<Item = &'a char>) -> bool {
        for character in characters {
            match get_general_category(*character) {
                GeneralCategory::NonspacingMark
                | GeneralCategory::SpacingMark
                | GeneralCategory::EnclosingMark
                | GeneralCategory::ModifierSymbol => continue,
                GeneralCategory::OtherSymbol => return true,
                _ => return false,
            }
        }
        false
    }

    neighboring_symbol(characters[..index].iter().rev())
        && neighboring_symbol(characters[index + 1..].iter())
}

/// Account storage predates the product snapshot and already permits emoji
/// graphemes such as `👩‍💻`. Keep those labels losslessly readable so users can
/// rename them, while rejecting every other format/control character on new
/// writes. The stricter product projection still rejects all `Cf` text rather
/// than rewriting an existing display identity.
fn valid_account_registry_label(label: &str) -> bool {
    if !bounded_string(
        label,
        MAX_PROVIDER_PRODUCT_DISPLAY_NAME_UTF8_BYTES,
        MAX_PROVIDER_PRODUCT_DISPLAY_NAME_SCALARS,
    ) || label.trim().is_empty()
    {
        return false;
    }
    let characters = label.chars().collect::<Vec<_>>();
    characters.iter().enumerate().all(
        |(index, character)| match get_general_category(*character) {
            GeneralCategory::Control
            | GeneralCategory::LineSeparator
            | GeneralCategory::ParagraphSeparator
            | GeneralCategory::Surrogate => false,
            GeneralCategory::Format => {
                *character == '\u{200d}'
                    && legacy_emoji_joiner_has_symbol_neighbors(&characters, index)
            }
            _ => true,
        },
    )
}

fn valid_account_agent_dir(agent_dir: &str) -> bool {
    bounded_string(
        agent_dir,
        MAX_ACCOUNT_AGENT_DIR_UTF8_BYTES,
        MAX_ACCOUNT_AGENT_DIR_SCALARS,
    ) && !agent_dir.contains('\0')
}

fn validate_account_label(label: String) -> Result<String, String> {
    let label = label.trim().to_owned();
    if label.is_empty() {
        return Err("account label is required".to_owned());
    }
    if !valid_account_registry_label(&label) {
        return Err("account label cannot contain control or bidirectional formatting characters, other unsafe display characters, or exceed product limits".to_owned());
    }
    Ok(label)
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub label: String,
    pub provider: String,
    pub agent_dir: String,
    pub created_at: u64,
}

struct ValidatedStringSeed {
    validate: fn(&str) -> bool,
    expectation: &'static str,
}

impl<'de> DeserializeSeed<'de> for ValidatedStringSeed {
    type Value = String;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_str(self)
    }
}

impl Visitor<'_> for ValidatedStringSeed {
    type Value = String;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.expectation)
    }

    fn visit_borrowed_str<E>(self, value: &str) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        if !(self.validate)(value) {
            return Err(E::custom(self.expectation));
        }
        Ok(value.to_owned())
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        self.visit_borrowed_str(value)
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        if !(self.validate)(&value) {
            return Err(E::custom(self.expectation));
        }
        Ok(value)
    }
}

fn deserialize_account_id<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    ValidatedStringSeed {
        validate: valid_provider_product_account_id,
        expectation: "a canonical bounded account ID",
    }
    .deserialize(deserializer)
}

fn deserialize_provider_id<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    ValidatedStringSeed {
        validate: valid_provider_product_provider_id,
        expectation: "a canonical bounded provider ID",
    }
    .deserialize(deserializer)
}

fn deserialize_registry_label<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    ValidatedStringSeed {
        validate: valid_account_registry_label,
        expectation: "a bounded safe account display name",
    }
    .deserialize(deserializer)
}

fn deserialize_agent_dir<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    ValidatedStringSeed {
        validate: valid_account_agent_dir,
        expectation: "a bounded account agent directory",
    }
    .deserialize(deserializer)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StrictPersistedAccount {
    #[serde(deserialize_with = "deserialize_account_id")]
    id: String,
    #[serde(deserialize_with = "deserialize_registry_label")]
    label: String,
    #[serde(deserialize_with = "deserialize_provider_id")]
    provider: String,
    #[serde(deserialize_with = "deserialize_agent_dir")]
    agent_dir: String,
    created_at: u64,
}

impl From<StrictPersistedAccount> for Account {
    fn from(account: StrictPersistedAccount) -> Self {
        Self {
            id: account.id,
            label: account.label,
            provider: account.provider,
            agent_dir: account.agent_dir,
            created_at: account.created_at,
        }
    }
}

fn validate_account_collection(accounts: &[Account]) -> Result<(), &'static str> {
    if accounts.len() > MAX_PROVIDER_PRODUCT_ACCOUNTS {
        return Err("account registry exceeds the account limit");
    }
    let mut account_ids = BTreeSet::new();
    let mut provider_ids = BTreeSet::from(["anthropic", "openai-codex"]);
    for account in accounts {
        if !valid_provider_product_account_id(&account.id)
            || !account_ids.insert(account.id.as_str())
            || !valid_provider_product_provider_id(&account.provider)
            || !valid_account_registry_label(&account.label)
            || !valid_account_agent_dir(&account.agent_dir)
        {
            return Err("account registry violates the provider product contract");
        }
        provider_ids.insert(account.provider.as_str());
        if provider_ids.len() > MAX_PROVIDER_PRODUCT_PROVIDERS {
            return Err("account registry exceeds the provider limit");
        }
    }
    Ok(())
}

struct AccountRegistryVisitor;

impl<'de> Visitor<'de> for AccountRegistryVisitor {
    type Value = Vec<Account>;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a bounded account registry array")
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let capacity = sequence
            .size_hint()
            .unwrap_or(0)
            .min(MAX_PROVIDER_PRODUCT_ACCOUNTS);
        let mut accounts = Vec::with_capacity(capacity);
        let mut account_ids = BTreeSet::new();
        let mut provider_ids = BTreeSet::from(["anthropic".to_owned(), "openai-codex".to_owned()]);

        for _ in 0..MAX_PROVIDER_PRODUCT_ACCOUNTS {
            let Some(account) = sequence.next_element::<StrictPersistedAccount>()? else {
                return Ok(accounts);
            };
            if !account_ids.insert(account.id.clone()) {
                return Err(A::Error::custom("duplicate account ID"));
            }
            provider_ids.insert(account.provider.clone());
            if provider_ids.len() > MAX_PROVIDER_PRODUCT_PROVIDERS {
                return Err(A::Error::custom(
                    "account registry exceeds the provider limit",
                ));
            }
            accounts.push(account.into());
        }

        if sequence.next_element::<IgnoredAny>()?.is_some() {
            return Err(A::Error::custom(
                "account registry exceeds the account limit",
            ));
        }
        Ok(accounts)
    }
}

pub(crate) fn parse_account_registry(bytes: &[u8]) -> Result<Vec<Account>, String> {
    if bytes.len() > MAX_ACCOUNT_REGISTRY_BYTES {
        return Err("account registry exceeds the byte limit".to_owned());
    }
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    let accounts =
        serde::de::Deserializer::deserialize_seq(&mut deserializer, AccountRegistryVisitor)
            .map_err(|error| format!("account registry is invalid: {error}"))?;
    deserializer
        .end()
        .map_err(|error| format!("account registry is invalid: {error}"))?;
    Ok(accounts)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AccountRegistryReadError {
    Invalid,
    Io,
}

pub(crate) fn read_account_registry_bounded(
    path: &Path,
) -> Result<(Vec<u8>, Vec<Account>), AccountRegistryReadError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| AccountRegistryReadError::Io)?;
    if metadata.len() > MAX_ACCOUNT_REGISTRY_BYTES as u64 {
        return Err(AccountRegistryReadError::Invalid);
    }
    let bounded = match read_bounded(path, MAX_ACCOUNT_REGISTRY_BYTES) {
        Ok(bounded) => bounded,
        Err(_) => {
            return Err(match fs::symlink_metadata(path) {
                Ok(metadata) if metadata.len() > MAX_ACCOUNT_REGISTRY_BYTES as u64 => {
                    AccountRegistryReadError::Invalid
                }
                _ => AccountRegistryReadError::Io,
            });
        }
    };
    let accounts =
        parse_account_registry(&bounded.bytes).map_err(|_| AccountRegistryReadError::Invalid)?;
    Ok((bounded.bytes, accounts))
}

struct MigratedProviderVisitor;

impl<'de> Visitor<'de> for MigratedProviderVisitor {
    type Value = Vec<String>;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a bounded provider credential object")
    }

    fn visit_map<A>(self, mut object: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut entries = 0_usize;
        let mut providers = Vec::new();
        let mut auth_provider_ids = BTreeSet::new();
        let mut product_provider_ids =
            BTreeSet::from(["anthropic".to_owned(), "openai-codex".to_owned()]);

        while let Some(provider) = object.next_key_seed(ValidatedStringSeed {
            validate: valid_provider_product_provider_id,
            expectation: "a canonical bounded provider ID",
        })? {
            entries += 1;
            if entries > MAX_PROVIDER_PRODUCT_PROVIDERS
                || !auth_provider_ids.insert(provider.clone())
            {
                return Err(A::Error::custom("auth provider inventory is invalid"));
            }
            product_provider_ids.insert(provider.clone());
            if product_provider_ids.len() > MAX_PROVIDER_PRODUCT_PROVIDERS {
                return Err(A::Error::custom(
                    "auth provider inventory exceeds the provider limit",
                ));
            }
            object.next_value::<IgnoredAny>()?;
            providers.push(provider);
        }
        providers.sort();
        Ok(providers)
    }
}

fn parse_migrated_providers(bytes: &[u8]) -> Result<Vec<String>, String> {
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    let providers =
        serde::de::Deserializer::deserialize_map(&mut deserializer, MigratedProviderVisitor)
            .map_err(|error| format!("account migration source is invalid: {error}"))?;
    deserializer
        .end()
        .map_err(|error| format!("account migration source is invalid: {error}"))?;
    Ok(providers)
}

#[derive(Debug)]
pub struct AccountRegistry {
    profiles_dir: PathBuf,
    default_agent_dir: PathBuf,
    mutation: Mutex<()>,
}

impl AccountRegistry {
    pub fn new(profiles_dir: PathBuf, default_agent_dir: PathBuf) -> Self {
        Self {
            profiles_dir,
            default_agent_dir,
            mutation: Mutex::new(()),
        }
    }

    pub fn profiles_dir(&self) -> &Path {
        &self.profiles_dir
    }

    pub fn default_agent_dir(&self) -> &Path {
        &self.default_agent_dir
    }

    pub fn registry_path(&self) -> PathBuf {
        self.profiles_dir.join("accounts.json")
    }

    pub fn list(&self) -> Result<Vec<Account>, String> {
        let _guard = self.lock()?;
        self.read_locked()
    }

    pub fn find(&self, id: &str) -> Result<Account, String> {
        let _guard = self.lock()?;
        self.read_locked()?
            .into_iter()
            .find(|account| account.id == id)
            .ok_or_else(|| format!("no such account: {id}"))
    }

    pub fn add(&self, label: String, provider: String, created_at: u64) -> Result<Account, String> {
        let label = validate_account_label(label)?;
        if provider != "anthropic" && provider != "openai-codex" {
            return Err(format!("unknown provider: {provider}"));
        }
        let _guard = self.lock()?;
        self.recover_pending_locked()?;
        let mut accounts = self.read_locked()?;
        if accounts.len() >= MAX_PROVIDER_PRODUCT_ACCOUNTS {
            return Err("account registry exceeds the account limit".to_owned());
        }
        let id = unique_id(&slug(&label), &accounts);
        let profile = self.profiles_dir.join(&id);
        fs::create_dir_all(&profile)
            .map_err(|error| format!("could not create account profile: {error}"))?;
        let account = Account {
            id,
            label,
            provider,
            agent_dir: profile.to_string_lossy().into_owned(),
            created_at,
        };
        accounts.push(account.clone());
        self.write_locked(&accounts)?;
        Ok(account)
    }

    pub fn rename(&self, id: &str, label: String) -> Result<(), String> {
        let label = validate_account_label(label)?;
        let _guard = self.lock()?;
        self.recover_pending_locked()?;
        let mut accounts = self.read_locked()?;
        let account = accounts
            .iter_mut()
            .find(|account| account.id == id)
            .ok_or_else(|| format!("no such account: {id}"))?;
        account.label = label;
        self.write_locked(&accounts)
    }

    pub fn remove_entry(&self, id: &str) -> Result<Account, String> {
        let _guard = self.lock()?;
        self.recover_pending_locked()?;
        let mut accounts = self.read_locked()?;
        let position = accounts
            .iter()
            .position(|account| account.id == id)
            .ok_or_else(|| format!("no such account: {id}"))?;
        let removed = accounts.remove(position);
        self.write_locked(&accounts)?;
        Ok(removed)
    }

    pub(crate) fn lock(&self) -> Result<MutexGuard<'_, ()>, String> {
        self.mutation
            .lock()
            .map_err(|_| "account registry lock poisoned".to_owned())
    }

    pub(crate) fn read_locked(&self) -> Result<Vec<Account>, String> {
        let path = self.registry_path();
        match fs::symlink_metadata(&path) {
            Ok(_) => read_account_registry_bounded(&path)
                .map(|(_, accounts)| accounts)
                .map_err(|error| match error {
                    AccountRegistryReadError::Invalid => "account registry is invalid".to_owned(),
                    AccountRegistryReadError::Io => {
                        "could not read bounded account registry".to_owned()
                    }
                }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => self.migrate_locked(),
            Err(_) => Err("could not inspect account registry".to_owned()),
        }
    }

    fn migrate_locked(&self) -> Result<Vec<Account>, String> {
        let auth_path = self.default_agent_dir.join("auth.json");
        let mut providers = match fs::symlink_metadata(&auth_path) {
            Ok(_) => {
                let bounded = read_bounded(&auth_path, MAX_AUTH_FILE_BYTES)
                    .map_err(|_| "could not read bounded account migration source".to_owned())?;
                parse_migrated_providers(&bounded.bytes)?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(_) => return Err("could not inspect account migration source".to_owned()),
        };
        if providers.is_empty() {
            providers.push("anthropic".to_owned());
        }
        let created_at = crate::now_ms();
        let accounts = providers
            .into_iter()
            .map(|provider| Account {
                id: format!("default-{provider}"),
                label: format!("Default ({})", provider_name(&provider)),
                provider,
                agent_dir: self.default_agent_dir.to_string_lossy().into_owned(),
                created_at,
            })
            .collect::<Vec<_>>();
        self.write_locked(&accounts)?;
        Ok(accounts)
    }

    pub(crate) fn write_locked(&self, accounts: &[Account]) -> Result<(), String> {
        validate_account_collection(accounts).map_err(str::to_owned)?;
        fs::create_dir_all(&self.profiles_dir)
            .map_err(|error| format!("could not create profiles directory: {error}"))?;
        let bytes = serde_json::to_vec_pretty(accounts)
            .map_err(|error| format!("could not serialize account registry: {error}"))?;
        if bytes.len() > MAX_ACCOUNT_REGISTRY_BYTES {
            return Err("account registry exceeds the byte limit".to_owned());
        }
        atomic_replace(&self.registry_path(), &bytes)
            .map_err(|error| format!("could not replace account registry: {error}"))
    }

    pub(crate) fn replace_with_proposed_locked(
        &self,
        proposed_path: &Path,
        proposed: recovery::SealedProposedRegistry,
    ) -> Result<delete::FileIdentity, recovery::ProposalInstallError> {
        if proposed_path.parent() != Some(self.profiles_dir()) {
            return Err(recovery::ProposalInstallError {
                error: std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "proposed registry is not in the profiles directory",
                ),
                namespace_replaced: false,
            });
        }
        proposed.install(&self.registry_path(), self.profiles_dir())
    }

    fn recover_pending_locked(&self) -> Result<(), String> {
        recovery::recover_locked(self)
            .map(|_| ())
            .map_err(|error| format!("pending account transaction could not be recovered: {error}"))
    }
}

fn provider_name(provider: &str) -> &str {
    match provider {
        "anthropic" => "Claude",
        "openai-codex" => "ChatGPT",
        other => other,
    }
}

pub(crate) fn slug(label: &str) -> String {
    let mut slug = String::new();
    for character in label.chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character.to_ascii_lowercase());
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug: String = slug.trim_matches('-').chars().take(40).collect();
    if slug.is_empty() {
        "account".to_owned()
    } else {
        slug
    }
}

pub(crate) fn unique_id(base: &str, accounts: &[Account]) -> String {
    let mut id = base.to_owned();
    let mut suffix = 1;
    while accounts.iter().any(|account| account.id == id) {
        suffix += 1;
        id = format!("{base}-{suffix}");
    }
    id
}

pub(crate) fn atomic_replace(destination: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = destination.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "registry has no parent directory",
        )
    })?;
    let sequence = NEXT_TEMP_FILE.fetch_add(1, Ordering::Relaxed);
    let temporary = parent.join(format!(
        ".accounts.json.{}.{}.tmp",
        std::process::id(),
        sequence
    ));

    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;

            use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_WRITE_THROUGH;

            options.custom_flags(FILE_FLAG_WRITE_THROUGH);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        replace_file(&temporary, destination)?;
        sync_parent(parent)?;
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Storage::FileSystem::{ReplaceFileW, REPLACEFILE_WRITE_THROUGH};

    if !destination.exists() {
        return durable_rename(source, destination);
    }

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let replaced = unsafe {
        ReplaceFileW(
            destination.as_ptr(),
            source.as_ptr(),
            std::ptr::null(),
            REPLACEFILE_WRITE_THROUGH,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if replaced == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
pub(crate) fn durable_rename(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};

    let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let moved = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        return Err(std::io::Error::last_os_error());
    }
    let source_parent = source.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "rename source has no parent",
        )
    })?;
    let destination_parent = destination.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "rename destination has no parent",
        )
    })?;
    sync_parent(destination_parent)?;
    if source_parent != destination_parent {
        sync_parent(source_parent)?;
    }
    Ok(())
}

#[cfg(not(windows))]
pub(crate) fn durable_rename(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)?;
    let source_parent = source.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "rename source has no parent",
        )
    })?;
    let destination_parent = destination.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "rename destination has no parent",
        )
    })?;
    sync_parent(destination_parent)?;
    if source_parent != destination_parent {
        sync_parent(source_parent)?;
    }
    Ok(())
}

#[cfg(windows)]
fn open_durable_remove_handle(
    path: &Path,
    access: u32,
    share_mode: u32,
) -> std::io::Result<fs::File> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;

    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_FLAG_WRITE_THROUGH, OPEN_EXISTING,
    };

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            access,
            share_mode,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { fs::File::from_raw_handle(handle) })
}

#[cfg(windows)]
fn mark_durable_remove(file: &fs::File) -> std::io::Result<()> {
    use std::os::windows::io::AsRawHandle;

    use windows_sys::Win32::Storage::FileSystem::{
        FileDispositionInfo, SetFileInformationByHandle, FILE_DISPOSITION_INFO,
    };

    let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
    let removed = unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle() as _,
            FileDispositionInfo,
            &disposition as *const FILE_DISPOSITION_INFO as *const _,
            std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    };
    if removed == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(windows)]
fn durable_remove_entry(
    path: &Path,
    directory: bool,
    expected_identity: Option<&delete::FileIdentity>,
) -> std::io::Result<()> {
    use windows_sys::Win32::Foundation::GENERIC_WRITE;
    use windows_sys::Win32::Storage::FileSystem::{
        DELETE, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    let file = open_durable_remove_handle(
        path,
        DELETE | GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    )?;
    let snapshot = recovery::file_snapshot(&file)?;
    if let Some(expected) = expected_identity {
        if snapshot.identity != *expected
            || snapshot.reparse_point
            || snapshot.directory
            || snapshot.hard_links != 1
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "durable removal target identity changed",
            ));
        }
    }
    if !snapshot.reparse_point && snapshot.directory != directory {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "durable removal target type changed",
        ));
    }
    mark_durable_remove(&file)?;
    drop(file);
    sync_parent(path.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "durable removal target has no parent",
        )
    })?)
}

#[cfg(windows)]
pub(crate) fn durable_remove_cleanup_entry<O, B, A>(
    root: &Path,
    expected_root: &delete::FileIdentity,
    path: &Path,
    expected_entry: &delete::PathSnapshot,
    mut on_path_open: O,
    before_remove: B,
    after_remove: A,
) -> std::io::Result<()>
where
    O: FnMut() -> std::io::Result<()>,
    B: FnOnce() -> std::io::Result<()>,
    A: FnOnce() -> std::io::Result<()>,
{
    use windows_sys::Win32::Foundation::GENERIC_WRITE;
    use windows_sys::Win32::Storage::FileSystem::{
        DELETE, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    let root_guard = if path == root {
        None
    } else {
        // Omitting delete sharing pins the verified quarantine namespace through the
        // descendant mutation and its parent-directory durability barrier.
        let guard = open_durable_remove_handle(
            root,
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
        )?;
        on_path_open()?;
        let snapshot = recovery::file_snapshot(&guard)?;
        if snapshot.identity != *expected_root || snapshot.reparse_point || !snapshot.directory {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "cleanup root identity changed",
            ));
        }
        Some(guard)
    };

    // This is the deletion handle itself: identity/shape validation and disposition
    // therefore cannot select two different pathname occupants.
    let entry = open_durable_remove_handle(
        path,
        DELETE | GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
    )?;
    on_path_open()?;
    let snapshot = recovery::file_snapshot(&entry)?;
    if snapshot.identity != expected_entry.identity
        || snapshot.reparse_point != expected_entry.reparse_point
        || snapshot.directory != expected_entry.directory
        || snapshot.hard_links != expected_entry.hard_links
        || (path == root && snapshot.identity != *expected_root)
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "cleanup entry identity changed",
        ));
    }

    before_remove()?;
    let snapshot_after_ownership_proof = recovery::file_snapshot(&entry)?;
    if snapshot_after_ownership_proof != *expected_entry
        || (path == root && snapshot_after_ownership_proof.identity != *expected_root)
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "cleanup entry identity changed during its ownership proof",
        ));
    }
    mark_durable_remove(&entry)?;
    drop(entry);
    sync_parent(path.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "durable cleanup target has no parent",
        )
    })?)?;
    // Record completion only after the exact, validated handle mutation and its
    // parent durability barrier. A missing name without this receipt stays uncertain.
    after_remove()?;
    drop(root_guard);
    Ok(())
}

#[cfg(windows)]
pub(crate) fn durable_remove_file(path: &Path) -> std::io::Result<()> {
    durable_remove_entry(path, false, None)
}

#[cfg(windows)]
pub(crate) fn durable_remove_dir(path: &Path) -> std::io::Result<()> {
    durable_remove_entry(path, true, None)
}

#[cfg(windows)]
pub(crate) fn durable_remove_file_if_identity(
    path: &Path,
    expected: &delete::FileIdentity,
) -> std::io::Result<()> {
    durable_remove_entry(path, false, Some(expected))
}

#[cfg(not(windows))]
pub(crate) fn durable_remove_file(path: &Path) -> std::io::Result<()> {
    fs::remove_file(path)?;
    sync_parent(path.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "durable removal target has no parent",
        )
    })?)
}

#[cfg(not(windows))]
pub(crate) fn durable_remove_cleanup_entry<O, B, A>(
    _root: &Path,
    _expected_root: &delete::FileIdentity,
    _path: &Path,
    _expected_entry: &delete::PathSnapshot,
    _on_path_open: O,
    _before_remove: B,
    _after_remove: A,
) -> std::io::Result<()>
where
    O: FnMut() -> std::io::Result<()>,
    B: FnOnce() -> std::io::Result<()>,
    A: FnOnce() -> std::io::Result<()>,
{
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "identity-bound cleanup is unavailable on this platform",
    ))
}

#[cfg(not(windows))]
pub(crate) fn durable_remove_file_if_identity(
    _path: &Path,
    _expected: &delete::FileIdentity,
) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "identity-bound removal is unavailable on this platform",
    ))
}

#[cfg(not(windows))]
pub(crate) fn durable_remove_dir(path: &Path) -> std::io::Result<()> {
    fs::remove_dir(path)?;
    sync_parent(path.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "durable removal target has no parent",
        )
    })?)
}

#[cfg(unix)]
pub(crate) fn sync_parent(parent: &Path) -> std::io::Result<()> {
    File::open(parent)?.sync_all()
}

#[cfg(windows)]
pub(crate) fn sync_parent(parent: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;

    use windows_sys::Win32::Foundation::{GENERIC_WRITE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FlushFileBuffers, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_WRITE_THROUGH,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    let wide: Vec<u16> = parent.as_os_str().encode_wide().chain(Some(0)).collect();
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_WRITE_THROUGH,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error());
    }
    let file = unsafe { fs::File::from_raw_handle(handle) };
    let flushed = unsafe { FlushFileBuffers(handle) };
    if flushed == 0 {
        return Err(std::io::Error::last_os_error());
    }
    drop(file);
    Ok(())
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn sync_parent(_parent: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "durable parent synchronization is unavailable on this platform",
    ))
}
