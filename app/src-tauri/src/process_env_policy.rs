//! Pure policy for constructing a Windows child-process environment.
//!
//! This module has no ambient-environment access and does not spawn processes.
//! Callers provide runtime variable names and a lazy value reader so values that
//! policy removes never need to be fetched.
//!
//! The returned variables are the complete child environment, not a delta. A
//! future process integration must clear inherited variables before applying
//! them. `caller_nonsecret` is deliberately named: callers must never use that
//! channel for credentials, and forbidden names are rejected from both sources.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::{OsStr, OsString};
use std::fmt;

// These are the only ambient values needed by Windows and child runtimes. User
// profile, application-data and executable-search locations must be explicit
// caller values instead of ambient inheritance.
const WINDOWS_RUNTIME_ALLOWLIST: &[&str] = &["COMSPEC", "SYSTEMROOT", "TEMP", "TMP", "WINDIR"];

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum VariableSource {
    Runtime,
    Caller,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum RemovalReason {
    NotRuntimeAllowlisted,
    ForbiddenName,
    CaseInsensitiveCollision,
    InvalidName,
    InvalidValue,
    MissingRequiredRuntimeVariable,
    NotCallerAllowlisted,
    RuntimeValueUnavailable,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct RemovedVariable {
    /// Escaped variable name. This never contains the variable's value.
    pub name: String,
    pub source: VariableSource,
    pub reason: RemovalReason,
}

/// A complete, deterministic child environment plus names-only removals.
///
/// This type intentionally does not implement `Debug`: even nonsecret runtime
/// path values do not belong in routine diagnostic output.
pub struct ChildEnvironment {
    variables: Vec<(OsString, OsString)>,
    diagnostics: Vec<RemovedVariable>,
}

/// A names-only failure that never exposes a partial child environment.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EnvironmentPolicyError {
    diagnostics: Vec<RemovedVariable>,
}

enum PendingValue {
    Runtime,
    Caller(OsString),
}

struct PendingVariable {
    name: OsString,
    output_name: String,
    source: VariableSource,
    value: PendingValue,
}

impl ChildEnvironment {
    /// Variables using their approved spelling, sorted case-insensitively.
    pub fn variables(&self) -> &[(OsString, OsString)] {
        &self.variables
    }

    /// Deterministically sorted removal records containing names, never values.
    pub fn diagnostics(&self) -> &[RemovedVariable] {
        &self.diagnostics
    }
}

impl EnvironmentPolicyError {
    /// All removals observed while determining that required runtime state was
    /// missing, colliding, unavailable, or invalid.
    pub fn diagnostics(&self) -> &[RemovedVariable] {
        &self.diagnostics
    }
}

impl fmt::Display for EnvironmentPolicyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("required Windows runtime environment is incomplete")
    }
}

impl std::error::Error for EnvironmentPolicyError {}

/// Build a complete child environment without reading ambient state directly.
///
/// Runtime names are classified and collision-checked before `read_runtime` is
/// invoked. Consequently the callback is never called for invalid, forbidden,
/// non-allowlisted, or colliding runtime names. No environment is returned
/// unless every required Windows runtime variable has one usable value.
///
/// Names must be ASCII, nonempty, free of controls, and must not contain `=`.
/// Caller variables additionally need one unique, case-insensitive match in
/// `caller_allowed_names`; the output retains that approved name's spelling.
/// Secret and injection-name rules override caller approval.
pub fn build_child_environment<RuntimeNames, ReadRuntime, CallerAllowedNames, CallerValues>(
    runtime_names: RuntimeNames,
    mut read_runtime: ReadRuntime,
    caller_allowed_names: CallerAllowedNames,
    caller_nonsecret: CallerValues,
) -> Result<ChildEnvironment, EnvironmentPolicyError>
where
    RuntimeNames: IntoIterator<Item = OsString>,
    ReadRuntime: FnMut(&OsStr) -> Option<OsString>,
    CallerAllowedNames: IntoIterator<Item = OsString>,
    CallerValues: IntoIterator<Item = (OsString, OsString)>,
{
    let mut variables = BTreeMap::<String, (OsString, OsString)>::new();
    let mut diagnostics = Vec::new();
    let mut pending = BTreeMap::<String, Vec<PendingVariable>>::new();
    let mut required_runtime_seen = BTreeSet::<String>::new();
    let mut required_runtime_usable = BTreeSet::<String>::new();

    for name in runtime_names {
        if !valid_variable_name(&name) {
            diagnostics.push(RemovedVariable {
                name: diagnostic_name(&name),
                source: VariableSource::Runtime,
                reason: RemovalReason::InvalidName,
            });
        } else if forbidden_name(&name) {
            diagnostics.push(RemovedVariable {
                name: diagnostic_name(&name),
                source: VariableSource::Runtime,
                reason: RemovalReason::ForbiddenName,
            });
        } else if let Some(canonical) = allowed_runtime_name(&name) {
            required_runtime_seen.insert(canonical.to_owned());
            pending
                .entry(case_insensitive_key(&name))
                .or_default()
                .push(PendingVariable {
                    name,
                    output_name: canonical.to_owned(),
                    source: VariableSource::Runtime,
                    value: PendingValue::Runtime,
                });
        } else {
            diagnostics.push(RemovedVariable {
                name: diagnostic_name(&name),
                source: VariableSource::Runtime,
                reason: RemovalReason::NotRuntimeAllowlisted,
            });
        }
    }

    let mut caller_allowlist = BTreeMap::<String, Vec<String>>::new();
    for approved_name in caller_allowed_names {
        if !valid_variable_name(&approved_name) {
            continue;
        }
        let case_key = case_insensitive_key(&approved_name);
        caller_allowlist.entry(case_key).or_default().push(
            approved_name
                .to_str()
                .expect("validated caller allowlist names are ASCII")
                .to_owned(),
        );
    }

    for (name, value) in caller_nonsecret {
        if !valid_variable_name(&name) {
            diagnostics.push(RemovedVariable {
                name: diagnostic_name(&name),
                source: VariableSource::Caller,
                reason: RemovalReason::InvalidName,
            });
            continue;
        }
        if forbidden_name(&name) {
            diagnostics.push(RemovedVariable {
                name: diagnostic_name(&name),
                source: VariableSource::Caller,
                reason: RemovalReason::ForbiddenName,
            });
            continue;
        }
        let case_key = case_insensitive_key(&name);
        let Some(approved_spellings) = caller_allowlist.get(&case_key) else {
            diagnostics.push(RemovedVariable {
                name: diagnostic_name(&name),
                source: VariableSource::Caller,
                reason: RemovalReason::NotCallerAllowlisted,
            });
            continue;
        };
        if approved_spellings.len() != 1 {
            diagnostics.push(RemovedVariable {
                name: diagnostic_name(&name),
                source: VariableSource::Caller,
                reason: RemovalReason::CaseInsensitiveCollision,
            });
            continue;
        }
        let output_name = approved_spellings[0].clone();
        pending.entry(case_key).or_default().push(PendingVariable {
            name,
            output_name,
            source: VariableSource::Caller,
            value: PendingValue::Caller(value),
        });
    }

    for (case_key, candidates) in pending {
        if candidates.len() > 1 {
            diagnostics.extend(candidates.into_iter().map(|candidate| RemovedVariable {
                name: diagnostic_name(&candidate.name),
                source: candidate.source,
                reason: RemovalReason::CaseInsensitiveCollision,
            }));
            continue;
        }

        let candidate = candidates
            .into_iter()
            .next()
            .expect("a pending environment group is never empty");
        let PendingVariable {
            name,
            output_name,
            source,
            value,
        } = candidate;
        let value = match value {
            PendingValue::Runtime => read_runtime(&name),
            PendingValue::Caller(value) => Some(value),
        };
        match value {
            Some(value)
                if contains_nul(&value)
                    || (source == VariableSource::Runtime && value.is_empty()) =>
            {
                diagnostics.push(RemovedVariable {
                    name: diagnostic_name(&name),
                    source,
                    reason: RemovalReason::InvalidValue,
                })
            }
            Some(value) => {
                if source == VariableSource::Runtime {
                    required_runtime_usable.insert(output_name.clone());
                }
                variables.insert(case_key, (output_name.into(), value));
            }
            None => diagnostics.push(RemovedVariable {
                name: diagnostic_name(&name),
                source,
                reason: RemovalReason::RuntimeValueUnavailable,
            }),
        }
    }

    for required_name in WINDOWS_RUNTIME_ALLOWLIST {
        if !required_runtime_seen.contains(*required_name) {
            diagnostics.push(RemovedVariable {
                name: (*required_name).to_owned(),
                source: VariableSource::Runtime,
                reason: RemovalReason::MissingRequiredRuntimeVariable,
            });
        }
    }
    diagnostics.sort();
    if required_runtime_usable.len() != WINDOWS_RUNTIME_ALLOWLIST.len() {
        return Err(EnvironmentPolicyError { diagnostics });
    }
    Ok(ChildEnvironment {
        variables: variables.into_values().collect(),
        diagnostics,
    })
}

fn allowed_runtime_name(name: &OsStr) -> Option<&'static str> {
    let name = name.to_str()?;
    WINDOWS_RUNTIME_ALLOWLIST
        .iter()
        .find(|candidate| name.eq_ignore_ascii_case(candidate))
        .copied()
}

fn valid_variable_name(name: &OsStr) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    !name.is_empty()
        && name.is_ascii()
        && !name.contains('=')
        && !name.bytes().any(|byte| byte.is_ascii_control())
}

fn case_insensitive_key(name: &OsStr) -> String {
    name.to_str()
        .expect("only validated ASCII names become environment candidates")
        .to_ascii_uppercase()
}

#[cfg(windows)]
fn contains_nul(value: &OsStr) -> bool {
    use std::os::windows::ffi::OsStrExt;
    value.encode_wide().any(|unit| unit == 0)
}

#[cfg(unix)]
fn contains_nul(value: &OsStr) -> bool {
    use std::os::unix::ffi::OsStrExt;
    value.as_bytes().contains(&0)
}

#[cfg(not(any(windows, unix)))]
fn contains_nul(value: &OsStr) -> bool {
    value.to_string_lossy().contains('\0')
}

fn diagnostic_name(name: &OsStr) -> String {
    name.to_str()
        .map(|name| name.chars().flat_map(char::escape_default).collect())
        .unwrap_or_else(|| "<non-unicode>".to_owned())
}

fn forbidden_name(name: &OsStr) -> bool {
    let Some(name) = name.to_str() else {
        return true;
    };
    let name = name.to_ascii_uppercase();
    let segments = name
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let secret_segment = segments.iter().any(|segment| {
        matches!(
            *segment,
            "AUTH"
                | "AUTHORIZATION"
                | "BEARER"
                | "COOKIE"
                | "COOKIES"
                | "KEY"
                | "PASS"
                | "PASSWD"
                | "SECRET"
                | "SECRETS"
                | "TOKEN"
                | "TOKENS"
        )
    });
    let compact = name.replace('_', "");
    const CONCATENATED_SECRET_MARKERS: &[&str] = &[
        "ACCESSKEY",
        "ACCESSTOKEN",
        "APIKEY",
        "APISECRET",
        "AUTHCODE",
        "AUTHTOKEN",
        "BEARERTOKEN",
        "CLIENTSECRET",
        "CREDENTIAL",
        "IDTOKEN",
        "OAUTH",
        "PASSPHRASE",
        "PASSWORD",
        "PRIVATEKEY",
        "REFRESHTOKEN",
        "SECRETKEY",
        "SESSIONCOOKIE",
        "SESSIONTOKEN",
    ];
    let concatenated_secret = CONCATENATED_SECRET_MARKERS
        .iter()
        .any(|marker| compact.contains(marker));
    if secret_segment || concatenated_secret {
        return true;
    }

    const PROVIDER_PREFIXES: &[&str] = &[
        "ALIBABA_",
        "ANTHROPIC_",
        "AWS_",
        "AZURE_",
        "BEDROCK_",
        "BITBUCKET_",
        "CLAUDE_",
        "CODEX_",
        "COHERE_",
        "DATABRICKS_",
        "DEEPSEEK_",
        "FIREWORKS_",
        "GEMINI_",
        "GITHUB_",
        "GITLAB_",
        "GOOGLE_",
        "GROQ_",
        "HF_",
        "HUGGINGFACE_",
        "LANGCHAIN_",
        "LANGSMITH_",
        "MISTRAL_",
        "OCI_",
        "OPENAI_",
        "OPENROUTER_",
        "PERPLEXITY_",
        "REPLICATE_",
        "STABILITY_",
        "SUPABASE_",
        "TOGETHER_",
        "VERTEX_",
        "WANDB_",
        "XAI_",
    ];
    if PROVIDER_PREFIXES
        .iter()
        .any(|prefix| name.starts_with(prefix))
    {
        return true;
    }

    const FORBIDDEN_PREFIXES: &[&str] = &[
        "BASH_FUNC_",
        "CARGO_",
        "CMAKE_",
        "COMPLUS_",
        "CONDA_",
        "COREPACK_",
        "CORECLR_",
        "COR_",
        "DOTNET_",
        "DYLD_",
        "GIT_",
        "LD_",
        "LUA_",
        "NPM_",
        "PIP_",
        "PHP_",
        "PKG_CONFIG_",
        "PNPM_",
        "POETRY_",
        "PYTHON",
        "RUSTC_",
        "SSL_CERT_",
        "UV_",
        "YARN_",
    ];
    const FORBIDDEN_EXACT: &[&str] = &[
        "ALL_PROXY",
        "BASHOPTS",
        "BASH_ENV",
        "CDPATH",
        "CLASSPATH",
        "COMPILER_PATH",
        "CPATH",
        "CPLUS_INCLUDE_PATH",
        "CURL_CA_BUNDLE",
        "DATABASE_URL",
        "ENV",
        "GCC_EXEC_PREFIX",
        "GEM_HOME",
        "GEM_PATH",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "IFS",
        "INCLUDE",
        "JAVA_TOOL_OPTIONS",
        "JDK_JAVA_OPTIONS",
        "LIBPATH",
        "LIBRARY_PATH",
        "LIB",
        "NODE_EXTRA_CA_CERTS",
        "NODE_OPTIONS",
        "NODE_PATH",
        "NODE_REDIRECT_WARNINGS",
        "NODE_TLS_REJECT_UNAUTHORIZED",
        "NODE_V8_COVERAGE",
        "NO_PROXY",
        "OBJC_INCLUDE_PATH",
        "PATH",
        "PATHEXT",
        "PERLLIB",
        "PERL5LIB",
        "PERL5OPT",
        "PHPRC",
        "PSMODULEPATH",
        "REQUESTS_CA_BUNDLE",
        "RUBYLIB",
        "RUBYOPT",
        "RUSTFLAGS",
        "SHELLOPTS",
        "SHLIB_PATH",
        "SSLKEYLOGFILE",
        "SSH_ASKPASS",
        "SUDO_ASKPASS",
        "TCLLIBPATH",
        "VIRTUAL_ENV",
        "ZDOTDIR",
        "__COMPAT_LAYER",
        "_JAVA_OPTIONS",
        "__PYVENV_LAUNCHER__",
    ];
    FORBIDDEN_PREFIXES
        .iter()
        .any(|prefix| name.starts_with(prefix))
        || FORBIDDEN_EXACT.contains(&name.as_str())
}
