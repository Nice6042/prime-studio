use std::collections::BTreeSet;
use std::fmt;

use serde::Serialize;

use crate::accounts::{
    valid_provider_product_account_id, valid_provider_product_display_name,
    valid_provider_product_provider_id, Account, AccountRegistry, MAX_PROVIDER_PRODUCT_ACCOUNTS,
    MAX_PROVIDER_PRODUCT_PROVIDERS,
};
use crate::authority::{AuthorityGate, EffectClass, SecurityReadiness};

const PROVIDER_PRODUCT_SCHEMA_VERSION: u8 = 1;
const MAX_PROVIDER_PRODUCT_TRANSPORT_UTF8_BYTES: usize = 128 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ProviderProductSnapshotError;

impl fmt::Display for ProviderProductSnapshotError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("provider product snapshot unavailable")
    }
}

impl std::error::Error for ProviderProductSnapshotError {}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ProviderProductAdmission {
    Available,
    AdmissionOnly,
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderProductProvider {
    provider_id: String,
    display_name: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderProductAccount {
    account_id: String,
    provider_id: String,
    display_name: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderProductCapability {
    operation: &'static str,
    admission: ProviderProductAdmission,
    #[serde(skip_serializing_if = "Option::is_none")]
    unavailable_reason: Option<&'static str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderProductSnapshot {
    schema_version: u8,
    providers: Vec<ProviderProductProvider>,
    accounts: Vec<ProviderProductAccount>,
    capabilities: Vec<ProviderProductCapability>,
}

fn available(operation: &'static str) -> ProviderProductCapability {
    ProviderProductCapability {
        operation,
        admission: ProviderProductAdmission::Available,
        unavailable_reason: None,
    }
}

fn unimplemented_effect(
    gate: &AuthorityGate,
    operation: &'static str,
    effect: EffectClass,
) -> ProviderProductCapability {
    let (admission, unavailable_reason) = match gate.readiness(effect) {
        SecurityReadiness::Unavailable => (
            ProviderProductAdmission::Unavailable,
            "native_authority_unavailable",
        ),
        SecurityReadiness::AdmissionOnly => (
            ProviderProductAdmission::AdmissionOnly,
            "native_authority_admission_only",
        ),
        SecurityReadiness::Enforced => (
            ProviderProductAdmission::Unavailable,
            "native_implementation_unavailable",
        ),
    };
    ProviderProductCapability {
        operation,
        admission,
        unavailable_reason: Some(unavailable_reason),
    }
}

pub(crate) fn provider_product_snapshot_from_registry(
    gate: &AuthorityGate,
    registry: &AccountRegistry,
) -> Result<String, ProviderProductSnapshotError> {
    let accounts = registry.list().map_err(|_| ProviderProductSnapshotError)?;
    provider_product_snapshot(gate, &accounts)
}

/// Produce the credential-free provider/account view from native-owned state.
///
/// This is deliberately a projection rather than an authority input. The
/// WebView supplies no readiness, provider, account, or operation arguments,
/// and effectful product operations stay unavailable until a separate native
/// implementation explicitly removes their `unimplemented_effect` ceiling.
pub(crate) fn provider_product_snapshot(
    gate: &AuthorityGate,
    accounts: &[Account],
) -> Result<String, ProviderProductSnapshotError> {
    if accounts.len() > MAX_PROVIDER_PRODUCT_ACCOUNTS {
        return Err(ProviderProductSnapshotError);
    }

    let mut account_ids = BTreeSet::new();
    let mut provider_ids = BTreeSet::from(["anthropic", "openai-codex"]);
    for account in accounts {
        if !valid_provider_product_account_id(&account.id)
            || !account_ids.insert(account.id.as_str())
            || !valid_provider_product_provider_id(&account.provider)
            || !valid_provider_product_display_name(&account.label)
        {
            return Err(ProviderProductSnapshotError);
        }
        provider_ids.insert(account.provider.as_str());
        if provider_ids.len() > MAX_PROVIDER_PRODUCT_PROVIDERS {
            return Err(ProviderProductSnapshotError);
        }
    }

    let mut providers = vec![
        ProviderProductProvider {
            provider_id: "anthropic".to_owned(),
            display_name: "Claude".to_owned(),
        },
        ProviderProductProvider {
            provider_id: "openai-codex".to_owned(),
            display_name: "ChatGPT".to_owned(),
        },
    ];
    let extension_provider_ids = provider_ids
        .into_iter()
        .filter(|provider_id| *provider_id != "anthropic" && *provider_id != "openai-codex")
        .collect::<Vec<_>>();
    providers.extend(extension_provider_ids.into_iter().map(|provider_id| {
        ProviderProductProvider {
            provider_id: provider_id.to_owned(),
            display_name: provider_id.to_owned(),
        }
    }));

    let snapshot = ProviderProductSnapshot {
        schema_version: PROVIDER_PRODUCT_SCHEMA_VERSION,
        providers,
        accounts: accounts
            .iter()
            .map(|account| ProviderProductAccount {
                account_id: account.id.clone(),
                provider_id: account.provider.clone(),
                display_name: account.label.clone(),
            })
            .collect(),
        capabilities: vec![
            available("discover_providers"),
            available("discover_accounts"),
            unimplemented_effect(gate, "account_login", EffectClass::AccountAuthentication),
            unimplemented_effect(gate, "discover_models", EffectClass::PrimeCliProcess),
            unimplemented_effect(gate, "start", EffectClass::PrimeSessionProcess),
            unimplemented_effect(gate, "resume", EffectClass::PrimeSessionProcess),
            unimplemented_effect(gate, "send", EffectClass::PrimeRpcTurn),
        ],
    };
    let transport = serde_json::to_string(&snapshot).map_err(|_| ProviderProductSnapshotError)?;
    if transport.len() > MAX_PROVIDER_PRODUCT_TRANSPORT_UTF8_BYTES {
        return Err(ProviderProductSnapshotError);
    }
    Ok(transport)
}

#[cfg(test)]
mod tests {
    use super::{
        provider_product_snapshot, provider_product_snapshot_from_registry,
        ProviderProductSnapshotError, MAX_PROVIDER_PRODUCT_ACCOUNTS,
        MAX_PROVIDER_PRODUCT_PROVIDERS, MAX_PROVIDER_PRODUCT_TRANSPORT_UTF8_BYTES,
    };
    use crate::accounts::{
        Account, AccountRegistry, MAX_ACCOUNT_REGISTRY_BYTES, MAX_AUTH_FILE_BYTES,
        MAX_PROVIDER_PRODUCT_DISPLAY_NAME_SCALARS, MAX_PROVIDER_PRODUCT_DISPLAY_NAME_UTF8_BYTES,
    };
    use crate::authority::{AuthorityGate, EffectClass, SecurityReadiness};
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;

    struct RegistryFixture {
        root: PathBuf,
        registry: AccountRegistry,
        profiles: PathBuf,
        agent: PathBuf,
    }

    impl RegistryFixture {
        fn new(case: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "prime-provider-product-{case}-{}",
                uuid::Uuid::new_v4()
            ));
            let profiles = root.join("profiles");
            let agent = root.join("agent");
            fs::create_dir_all(&agent).expect("create provider product agent fixture");
            let registry = AccountRegistry::new(profiles.clone(), agent.clone());
            Self {
                root,
                registry,
                profiles,
                agent,
            }
        }

        fn snapshot(&self) -> Result<String, ProviderProductSnapshotError> {
            provider_product_snapshot_from_registry(&AuthorityGate::phase_zero(), &self.registry)
        }

        fn write_registry(&self, value: &serde_json::Value) {
            fs::create_dir_all(&self.profiles).expect("create profiles fixture");
            fs::write(
                self.registry.registry_path(),
                serde_json::to_vec(value).expect("serialize registry fixture"),
            )
            .expect("write registry fixture");
        }
    }

    impl Drop for RegistryFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn account() -> Account {
        Account {
            id: "claude-work".to_owned(),
            label: "Claude work".to_owned(),
            provider: "anthropic".to_owned(),
            agent_dir: r"C:\credential-bearing-agent-home".to_owned(),
            created_at: 42,
        }
    }

    #[test]
    fn every_migrated_account_provider_has_a_native_owned_descriptor() {
        let mut extension_account = account();
        extension_account.id = "extension-work".to_owned();
        extension_account.provider = "legacy-provider".to_owned();

        let transport = provider_product_snapshot(
            &AuthorityGate::phase_zero(),
            &[account(), extension_account],
        )
        .expect("safe extension provider migrates");
        let snapshot: serde_json::Value =
            serde_json::from_str(&transport).expect("snapshot transport parses");

        assert_eq!(
            snapshot["providers"][2],
            json!({
                "providerId": "legacy-provider",
                "displayName": "legacy-provider"
            })
        );
        assert_eq!(snapshot["accounts"][1]["providerId"], "legacy-provider");
    }

    #[test]
    fn native_projection_enforces_inclusive_provider_and_account_count_caps() {
        let accounts_at_cap: Vec<Account> = (0..MAX_PROVIDER_PRODUCT_ACCOUNTS)
            .map(|index| Account {
                id: format!("account-{index}"),
                ..account()
            })
            .collect();
        provider_product_snapshot(&AuthorityGate::phase_zero(), &accounts_at_cap)
            .expect("account cap is inclusive");

        let mut accounts_over_cap = accounts_at_cap;
        accounts_over_cap.push(Account {
            id: "account-over-cap".to_owned(),
            ..account()
        });
        assert_eq!(
            provider_product_snapshot(&AuthorityGate::phase_zero(), &accounts_over_cap),
            Err(ProviderProductSnapshotError)
        );

        let extensions_at_cap: Vec<Account> = (0..(MAX_PROVIDER_PRODUCT_PROVIDERS - 2))
            .map(|index| Account {
                id: format!("extension-{index}"),
                provider: format!("provider-{index}"),
                ..account()
            })
            .collect();
        provider_product_snapshot(&AuthorityGate::phase_zero(), &extensions_at_cap)
            .expect("provider cap is inclusive");

        let mut extensions_over_cap = extensions_at_cap;
        extensions_over_cap.push(Account {
            id: "extension-over-cap".to_owned(),
            provider: "provider-over-cap".to_owned(),
            ..account()
        });
        assert_eq!(
            provider_product_snapshot(&AuthorityGate::phase_zero(), &extensions_over_cap),
            Err(ProviderProductSnapshotError)
        );
    }

    #[test]
    fn native_projection_rejects_noncanonical_or_oversized_ids_without_echoing_them() {
        let invalid_provider_ids = [
            "Uppercase".to_owned(),
            "extension:legacy".to_owned(),
            "-leading".to_owned(),
            "trailing-".to_owned(),
            "with.dot".to_owned(),
            "é".to_owned(),
            "p".repeat(57),
        ];
        for provider in invalid_provider_ids {
            let invalid = Account {
                provider,
                ..account()
            };
            let error = provider_product_snapshot(&AuthorityGate::phase_zero(), &[invalid])
                .expect_err("invalid provider id must fail closed");
            assert_eq!(error.to_string(), "provider product snapshot unavailable");
        }

        let invalid_account_ids = [
            "Uppercase".to_owned(),
            "account:colon".to_owned(),
            "-leading".to_owned(),
            "trailing-".to_owned(),
            "con".to_owned(),
            "é".to_owned(),
            "a".repeat(65),
        ];
        for id in invalid_account_ids {
            let invalid = Account { id, ..account() };
            let error = provider_product_snapshot(&AuthorityGate::phase_zero(), &[invalid])
                .expect_err("invalid account id must fail closed");
            assert_eq!(error.to_string(), "provider product snapshot unavailable");
        }

        let exact_limits = Account {
            id: "a".repeat(64),
            provider: "p".repeat(56),
            ..account()
        };
        provider_product_snapshot(&AuthorityGate::phase_zero(), &[exact_limits])
            .expect("id byte and scalar caps are inclusive");
    }

    #[test]
    fn native_projection_rejects_unsafe_or_oversized_display_names() {
        for label in [
            "unsafe\u{0000}control".to_owned(),
            "unsafe\u{0085}control".to_owned(),
            "unsafe\u{200b}format".to_owned(),
            "unsafe\u{2028}line".to_owned(),
            "unsafe\u{2029}paragraph".to_owned(),
            "unsafe\u{202e}bidi".to_owned(),
            "x".repeat(MAX_PROVIDER_PRODUCT_DISPLAY_NAME_SCALARS + 1),
            "é".repeat((MAX_PROVIDER_PRODUCT_DISPLAY_NAME_UTF8_BYTES / 2) + 1),
        ] {
            let invalid = Account { label, ..account() };
            assert_eq!(
                provider_product_snapshot(&AuthorityGate::phase_zero(), &[invalid]),
                Err(ProviderProductSnapshotError)
            );
        }

        let exact_limits = Account {
            label: "é".repeat(MAX_PROVIDER_PRODUCT_DISPLAY_NAME_SCALARS),
            ..account()
        };
        let transport = provider_product_snapshot(&AuthorityGate::phase_zero(), &[exact_limits])
            .expect("display byte and scalar caps are inclusive");
        assert!(transport.len() <= MAX_PROVIDER_PRODUCT_TRANSPORT_UTF8_BYTES);
    }

    #[test]
    fn duplicate_persisted_account_ids_fail_closed() {
        let duplicate = account();
        assert_eq!(
            provider_product_snapshot(&AuthorityGate::phase_zero(), &[account(), duplicate]),
            Err(ProviderProductSnapshotError)
        );
    }

    #[test]
    fn real_registry_path_bounds_persisted_bytes_counts_and_fields_stably() {
        let oversized = RegistryFixture::new("oversized-registry");
        fs::create_dir_all(&oversized.profiles).expect("create profiles fixture");
        let file = fs::File::create(oversized.registry.registry_path())
            .expect("create oversized registry fixture");
        file.set_len((MAX_ACCOUNT_REGISTRY_BYTES + 1) as u64)
            .expect("size oversized registry fixture");
        let error = oversized
            .snapshot()
            .expect_err("oversized registry must fail closed");
        assert_eq!(error.to_string(), "provider product snapshot unavailable");

        let too_many = RegistryFixture::new("too-many-accounts");
        too_many.write_registry(&serde_json::Value::Array(
            (0..=MAX_PROVIDER_PRODUCT_ACCOUNTS)
                .map(|index| {
                    json!({
                        "id": format!("account-{index}"),
                        "label": format!("Account {index}"),
                        "provider": "anthropic",
                        "agentDir": too_many.agent.to_string_lossy(),
                        "createdAt": 1
                    })
                })
                .collect(),
        ));
        assert_eq!(
            too_many.snapshot(),
            Err(ProviderProductSnapshotError),
            "the registry reader must stop at the account ceiling"
        );

        for (case, field, value) in [
            ("unsafe-label", "label", "unsafe\u{200d}format"),
            ("invalid-provider", "provider", "extension:legacy"),
            ("invalid-account", "id", "Uppercase"),
        ] {
            let invalid = RegistryFixture::new(case);
            let mut persisted = serde_json::to_value(account()).expect("serialize account");
            persisted[field] = json!(value);
            invalid.write_registry(&json!([persisted]));
            let error = invalid
                .snapshot()
                .expect_err("invalid persisted field must fail closed");
            assert_eq!(error.to_string(), "provider product snapshot unavailable");
        }
    }

    #[test]
    fn migration_rejects_hostile_auth_without_creating_a_registry() {
        let cases = [
            ("malformed", b"{".as_slice()),
            ("non-object", b"[]".as_slice()),
            ("invalid-provider", br#"{"extension:legacy":{}}"#.as_slice()),
        ];
        for (case, auth) in cases {
            let fixture = RegistryFixture::new(case);
            fs::write(fixture.agent.join("auth.json"), auth).expect("write hostile auth fixture");
            let error = fixture
                .snapshot()
                .expect_err("hostile auth migration must fail closed");
            assert_eq!(error.to_string(), "provider product snapshot unavailable");
            assert!(
                !fixture.registry.registry_path().exists(),
                "invalid migration must not persist a fallback identity"
            );
        }

        let too_many = RegistryFixture::new("too-many-auth-providers");
        let auth = serde_json::Value::Object(
            (0..MAX_PROVIDER_PRODUCT_PROVIDERS)
                .map(|index| (format!("provider-{index}"), json!({"secret": "SECRET"})))
                .collect(),
        );
        fs::write(
            too_many.agent.join("auth.json"),
            serde_json::to_vec(&auth).expect("serialize provider-count fixture"),
        )
        .expect("write provider-count fixture");
        assert_eq!(too_many.snapshot(), Err(ProviderProductSnapshotError));
        assert!(!too_many.registry.registry_path().exists());

        let oversized = RegistryFixture::new("oversized-auth");
        let file = fs::File::create(oversized.agent.join("auth.json"))
            .expect("create oversized auth fixture");
        file.set_len((MAX_AUTH_FILE_BYTES + 1) as u64)
            .expect("size oversized auth fixture");
        assert_eq!(oversized.snapshot(), Err(ProviderProductSnapshotError));
        assert!(!oversized.registry.registry_path().exists());
    }

    #[test]
    fn migration_distinguishes_missing_or_empty_auth_and_preserves_safe_extensions() {
        for case in ["missing-auth", "empty-auth"] {
            let fixture = RegistryFixture::new(case);
            if case == "empty-auth" {
                fs::write(fixture.agent.join("auth.json"), b"{}")
                    .expect("write empty auth fixture");
            }
            let transport = fixture
                .snapshot()
                .expect("missing or intentionally empty auth uses the documented default");
            let snapshot: serde_json::Value =
                serde_json::from_str(&transport).expect("snapshot transport parses");
            assert_eq!(snapshot["accounts"][0]["providerId"], "anthropic");
            assert!(fixture.registry.registry_path().exists());
        }

        let extension = RegistryFixture::new("safe-extension");
        fs::write(
            extension.agent.join("auth.json"),
            br#"{"legacy-provider":{"access":"SECRET","nested":{"refresh":"SECRET"}}}"#,
        )
        .expect("write safe extension fixture");
        let transport = extension
            .snapshot()
            .expect("safe extension provider migration remains lossless");
        assert!(!transport.contains("SECRET"));
        let snapshot: serde_json::Value =
            serde_json::from_str(&transport).expect("snapshot transport parses");
        assert_eq!(snapshot["providers"][2]["providerId"], "legacy-provider");
        assert_eq!(
            snapshot["accounts"][0]["accountId"],
            "default-legacy-provider"
        );
    }

    #[test]
    fn legacy_emoji_joiner_labels_remain_readable_and_recover_without_sanitizing() {
        let fixture = RegistryFixture::new("legacy-emoji-label");
        let account = fixture
            .registry
            .add(
                "Claude 👩\u{200d}💻 work".to_owned(),
                "anthropic".to_owned(),
                1,
            )
            .expect("protected emoji-joiner label remains registry-compatible");
        let before = fs::read(fixture.registry.registry_path()).expect("read registry fixture");

        let persisted = fixture
            .registry
            .list()
            .expect("legacy label remains readable");
        assert_eq!(
            persisted
                .iter()
                .find(|candidate| candidate.id == account.id)
                .map(|candidate| candidate.label.as_str()),
            Some("Claude 👩\u{200d}💻 work")
        );
        assert_eq!(fixture.snapshot(), Err(ProviderProductSnapshotError));
        assert_eq!(
            fs::read(fixture.registry.registry_path()).expect("reread registry fixture"),
            before,
            "fail-closed product projection must not rewrite a legacy identity"
        );

        fixture
            .registry
            .rename(&account.id, "Claude work".to_owned())
            .expect("safe rename recovers product projection");
        fixture
            .snapshot()
            .expect("safe renamed label is product-displayable");
    }

    #[test]
    fn phase_zero_snapshot_is_exact_credential_free_and_fail_closed() {
        let transport = provider_product_snapshot(&AuthorityGate::phase_zero(), &[account()])
            .expect("valid snapshot");
        let serialized: serde_json::Value =
            serde_json::from_str(&transport).expect("snapshot transport parses");

        assert_eq!(
            serialized,
            json!({
                "schemaVersion": 1,
                "providers": [
                    { "providerId": "anthropic", "displayName": "Claude" },
                    { "providerId": "openai-codex", "displayName": "ChatGPT" }
                ],
                "accounts": [
                    {
                        "accountId": "claude-work",
                        "providerId": "anthropic",
                        "displayName": "Claude work"
                    }
                ],
                "capabilities": [
                    { "operation": "discover_providers", "admission": "available" },
                    { "operation": "discover_accounts", "admission": "available" },
                    {
                        "operation": "account_login",
                        "admission": "unavailable",
                        "unavailableReason": "native_authority_unavailable"
                    },
                    {
                        "operation": "discover_models",
                        "admission": "unavailable",
                        "unavailableReason": "native_authority_unavailable"
                    },
                    {
                        "operation": "start",
                        "admission": "unavailable",
                        "unavailableReason": "native_authority_unavailable"
                    },
                    {
                        "operation": "resume",
                        "admission": "unavailable",
                        "unavailableReason": "native_authority_unavailable"
                    },
                    {
                        "operation": "send",
                        "admission": "unavailable",
                        "unavailableReason": "native_authority_unavailable"
                    }
                ]
            })
        );
        let text = serialized.to_string();
        assert!(!text.contains("agentDir"));
        assert!(!text.contains("credential-bearing-agent-home"));
        assert!(!text.contains("createdAt"));
    }

    #[test]
    fn admission_only_readiness_remains_explicit_in_the_product_snapshot() {
        let gate = AuthorityGate::from_test_readiness(&[
            (
                EffectClass::AccountAuthentication,
                SecurityReadiness::AdmissionOnly,
            ),
            (
                EffectClass::PrimeCliProcess,
                SecurityReadiness::AdmissionOnly,
            ),
            (
                EffectClass::PrimeSessionProcess,
                SecurityReadiness::AdmissionOnly,
            ),
            (EffectClass::PrimeRpcTurn, SecurityReadiness::AdmissionOnly),
        ]);

        let transport = provider_product_snapshot(&gate, &[]).expect("valid snapshot");
        let snapshot: serde_json::Value =
            serde_json::from_str(&transport).expect("snapshot transport parses");
        assert!(snapshot["capabilities"].as_array().unwrap()[2..]
            .iter()
            .all(|capability| capability["admission"] == "admission_only"
                && capability["unavailableReason"] == "native_authority_admission_only"));
    }

    #[test]
    fn enforced_readiness_cannot_mint_unimplemented_login_session_or_send_authority() {
        let gate = AuthorityGate::from_test_readiness(&[
            (
                EffectClass::AccountAuthentication,
                SecurityReadiness::Enforced,
            ),
            (EffectClass::PrimeCliProcess, SecurityReadiness::Enforced),
            (
                EffectClass::PrimeSessionProcess,
                SecurityReadiness::Enforced,
            ),
            (EffectClass::PrimeRpcTurn, SecurityReadiness::Enforced),
        ]);

        let transport = provider_product_snapshot(&gate, &[]).expect("valid snapshot");
        let snapshot: serde_json::Value =
            serde_json::from_str(&transport).expect("snapshot transport parses");
        assert!(snapshot["capabilities"].as_array().unwrap()[2..]
            .iter()
            .all(|capability| capability["admission"] == "unavailable"
                && capability["unavailableReason"] == "native_implementation_unavailable"));
    }
}
