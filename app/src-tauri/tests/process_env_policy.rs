#[path = "../src/process_env_policy.rs"]
mod process_env_policy;

use process_env_policy::{build_child_environment, RemovalReason, VariableSource};
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};

#[cfg(unix)]
fn non_unicode_name() -> OsString {
    use std::os::unix::ffi::OsStringExt;
    OsString::from_vec(vec![0xff])
}

#[cfg(windows)]
fn non_unicode_name() -> OsString {
    use std::os::windows::ffi::OsStringExt;
    OsString::from_wide(&[0xd800])
}

fn text_variables(variables: &[(OsString, OsString)]) -> Vec<(String, String)> {
    variables
        .iter()
        .map(|(name, value)| {
            (
                name.to_string_lossy().into_owned(),
                value.to_string_lossy().into_owned(),
            )
        })
        .collect()
}

fn required_runtime() -> BTreeMap<OsString, OsString> {
    BTreeMap::from([
        (
            OsString::from("ComSpec"),
            OsString::from(r"C:\Windows\System32\cmd.exe"),
        ),
        (OsString::from("SystemRoot"), OsString::from(r"C:\Windows")),
        (OsString::from("TEMP"), OsString::from(r"C:\Temp")),
        (OsString::from("TMP"), OsString::from(r"C:\Tmp")),
        (OsString::from("WINDIR"), OsString::from(r"C:\Windows")),
    ])
}

fn expected_required_runtime() -> Vec<(String, String)> {
    vec![
        ("COMSPEC".into(), r"C:\Windows\System32\cmd.exe".into()),
        ("SYSTEMROOT".into(), r"C:\Windows".into()),
        ("TEMP".into(), r"C:\Temp".into()),
        ("TMP".into(), r"C:\Tmp".into()),
        ("WINDIR".into(), r"C:\Windows".into()),
    ]
}

#[test]
fn inherits_only_required_windows_runtime_values_and_never_reads_the_rest() {
    let runtime = BTreeMap::from([
        (OsString::from("TEMP"), OsString::from(r"C:\runtime\temp")),
        (OsString::from("SystemRoot"), OsString::from(r"C:\Windows")),
        (
            OsString::from("USERPROFILE"),
            OsString::from(r"C:\ambient-user"),
        ),
        (
            OsString::from("ComSpec"),
            OsString::from(r"C:\Windows\System32\cmd.exe"),
        ),
        (OsString::from("TMP"), OsString::from(r"C:\runtime\tmp")),
        (OsString::from("NUMBER_OF_PROCESSORS"), OsString::from("64")),
        (OsString::from("WINDIR"), OsString::from(r"C:\Windows")),
    ]);
    let names = runtime.keys().cloned().collect::<Vec<_>>();
    let reads = RefCell::new(Vec::new());

    let outcome = build_child_environment(
        names,
        |name: &OsStr| {
            reads.borrow_mut().push(name.to_os_string());
            runtime.get(name).cloned()
        },
        [OsString::from("PRIME_AGENT_HOME"), OsString::from("HOME")],
        [
            (
                OsString::from("PRIME_AGENT_HOME"),
                OsString::from(r"C:\profile"),
            ),
            (OsString::from("home"), OsString::from(r"C:\profile")),
        ],
    )
    .expect("complete required runtime fixture");

    assert_eq!(
        text_variables(outcome.variables()),
        vec![
            ("COMSPEC".into(), r"C:\Windows\System32\cmd.exe".into()),
            ("HOME".into(), r"C:\profile".into()),
            ("PRIME_AGENT_HOME".into(), r"C:\profile".into()),
            ("SYSTEMROOT".into(), r"C:\Windows".into()),
            ("TEMP".into(), r"C:\runtime\temp".into()),
            ("TMP".into(), r"C:\runtime\tmp".into()),
            ("WINDIR".into(), r"C:\Windows".into()),
        ]
    );
    assert_eq!(
        reads.into_inner(),
        vec![
            OsString::from("ComSpec"),
            OsString::from("SystemRoot"),
            OsString::from("TEMP"),
            OsString::from("TMP"),
            OsString::from("WINDIR"),
        ],
        "removed ambient values must never be fetched"
    );

    let removed = outcome
        .diagnostics()
        .iter()
        .map(|diagnostic| {
            (
                diagnostic.name.as_str(),
                diagnostic.source,
                diagnostic.reason,
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        removed,
        vec![
            (
                "NUMBER_OF_PROCESSORS",
                VariableSource::Runtime,
                RemovalReason::NotRuntimeAllowlisted,
            ),
            (
                "USERPROFILE",
                VariableSource::Runtime,
                RemovalReason::NotRuntimeAllowlisted,
            ),
        ]
    );
}

#[test]
fn strips_secret_auth_provider_and_runtime_injection_names_without_value_leaks() {
    const RUNTIME_HONEYTOKEN: &str = "RUNTIME-HONEYTOKEN-MUST-NEVER-BE-READ";
    const CALLER_HONEYTOKEN: &str = "CALLER-HONEYTOKEN-MUST-NEVER-ESCAPE";

    let blocked_runtime_names = [
        "OPENAI_BASE_URL",
        "anthropic_api_key",
        "AWS_PROFILE",
        "MY_SESSION_TOKEN",
        "DATABASE_URL",
        "npm_config_userconfig",
        "NODE_OPTIONS",
        "Node_Path",
        "PYTHONPATH",
        "PYTHONHOME",
    ];
    let mut runtime_values = required_runtime();
    runtime_values.extend(
        blocked_runtime_names
            .map(|name| (OsString::from(name), OsString::from(RUNTIME_HONEYTOKEN))),
    );
    let runtime_names = runtime_values.keys().cloned().collect::<Vec<_>>();
    let runtime_reads = RefCell::new(Vec::new());
    let caller_blocked = [
        "PYTHONSTARTUP",
        "VIRTUAL_ENV",
        "PATH",
        "PATHEXT",
        "LD_PRELOAD",
        "DyLd_Insert_Libraries",
        "LIBPATH",
        "PSModulePath",
        "DOTNET_STARTUP_HOOKS",
        "JAVA_TOOL_OPTIONS",
        "BASH_ENV",
        "GIT_SSH_COMMAND",
        "SSH_ASKPASS",
    ];
    let caller_values = caller_blocked
        .iter()
        .map(|name| (OsString::from(name), OsString::from(CALLER_HONEYTOKEN)))
        .chain([(OsString::from("SAFE_MODE"), OsString::from("isolated"))])
        .collect::<Vec<_>>();
    let caller_allowlist = caller_values
        .iter()
        .map(|(name, _value)| name.clone())
        .collect::<Vec<_>>();

    let outcome = build_child_environment(
        runtime_names,
        |name: &OsStr| {
            runtime_reads.borrow_mut().push(name.to_os_string());
            runtime_values.get(name).cloned()
        },
        caller_allowlist,
        caller_values,
    )
    .expect("complete required runtime fixture");

    assert_eq!(
        text_variables(outcome.variables()),
        vec![
            ("COMSPEC".into(), r"C:\Windows\System32\cmd.exe".into()),
            ("SAFE_MODE".into(), "isolated".into()),
            ("SYSTEMROOT".into(), r"C:\Windows".into()),
            ("TEMP".into(), r"C:\Temp".into()),
            ("TMP".into(), r"C:\Tmp".into()),
            ("WINDIR".into(), r"C:\Windows".into()),
        ]
    );
    assert_eq!(
        runtime_reads.into_inner(),
        vec![
            OsString::from("ComSpec"),
            OsString::from("SystemRoot"),
            OsString::from("TEMP"),
            OsString::from("TMP"),
            OsString::from("WINDIR"),
        ],
        "the honeytoken-bearing runtime values must never be fetched"
    );

    let diagnostics = outcome.diagnostics();
    assert_eq!(diagnostics.len(), 23);
    assert!(diagnostics.iter().all(|diagnostic| {
        diagnostic.reason == RemovalReason::ForbiddenName
            && matches!(
                diagnostic.source,
                VariableSource::Runtime | VariableSource::Caller
            )
    }));
    for name in caller_blocked {
        assert!(
            diagnostics.iter().any(|diagnostic| {
                diagnostic.name.eq_ignore_ascii_case(name)
                    && diagnostic.source == VariableSource::Caller
            }),
            "missing caller diagnostic for {name}"
        );
    }

    let rendered_diagnostics = format!("{diagnostics:?}");
    assert!(!rendered_diagnostics.contains(RUNTIME_HONEYTOKEN));
    assert!(!rendered_diagnostics.contains(CALLER_HONEYTOKEN));
}

#[test]
fn case_insensitive_collisions_fail_closed_and_are_order_independent() {
    fn run(
        mut runtime_names: Vec<OsString>,
        mut caller_values: Vec<(OsString, OsString)>,
        reverse: bool,
    ) -> (Vec<process_env_policy::RemovedVariable>, Vec<OsString>) {
        if reverse {
            runtime_names.reverse();
            caller_values.reverse();
        }
        let reads = RefCell::new(Vec::new());
        let result = build_child_environment(
            runtime_names,
            |name: &OsStr| {
                reads.borrow_mut().push(name.to_os_string());
                match name.to_str() {
                    Some("ComSpec") => Some(OsString::from(r"C:\Windows\System32\cmd.exe")),
                    Some("SystemRoot") | Some("TMP") => Some(OsString::from(r"C:\Windows")),
                    _ => panic!("colliding runtime value was read for {name:?}"),
                }
            },
            ["SAFE_FLAG", "WINDIR", "DUP", "UNIQUE"].map(OsString::from),
            caller_values,
        );
        let error = match result {
            Err(error) => error,
            Ok(_environment) => panic!("a required runtime collision must fail construction"),
        };
        (error.diagnostics().to_vec(), reads.into_inner())
    }

    let runtime_names = ["ComSpec", "TEMP", "temp", "TMP", "WINDIR", "SystemRoot"]
        .map(OsString::from)
        .to_vec();
    let caller_values = [
        ("Safe_Flag", "first"),
        ("sAFE_fLAG", "second"),
        ("windir", "caller-shadow"),
        ("DUP", "first"),
        ("DUP", "second"),
        ("unique", "kept"),
    ]
    .map(|(name, value)| (OsString::from(name), OsString::from(value)))
    .to_vec();

    let forward = run(runtime_names.clone(), caller_values.clone(), false);
    let reversed = run(runtime_names, caller_values, true);

    assert_eq!(
        forward.1,
        vec![
            OsString::from("ComSpec"),
            OsString::from("SystemRoot"),
            OsString::from("TMP"),
        ]
    );
    assert_eq!(forward, reversed, "input order must not choose a winner");

    assert_eq!(forward.0.len(), 8);
    assert!(forward
        .0
        .iter()
        .all(|diagnostic| { diagnostic.reason == RemovalReason::CaseInsensitiveCollision }));
    assert_eq!(
        forward
            .0
            .iter()
            .filter(|diagnostic| diagnostic.name == "DUP")
            .count(),
        2,
        "exact duplicate names are collisions too"
    );
}

#[test]
fn rejects_invalid_names_nul_values_and_unicode_case_spoofs() {
    const VALUE_HONEYTOKEN: &str = "INVALID-VALUE-HONEYTOKEN-MUST-NOT-LEAK";

    let caller_values = vec![
        (OsString::new(), OsString::from("empty-name")),
        (OsString::from("BAD=NAME"), OsString::from("equals")),
        (OsString::from("NUL\0NAME"), OsString::from("name-nul")),
        (
            OsString::from("\u{202e}PATH"),
            OsString::from("bidi-control"),
        ),
        (non_unicode_name(), OsString::from("non-unicode")),
        (
            OsString::from("SAFE_NUL_VALUE"),
            OsString::from(format!("{VALUE_HONEYTOKEN}\0suffix")),
        ),
        (OsString::from("Straße"), OsString::from("first")),
        (OsString::from("STRAẞE"), OsString::from("second")),
        (OsString::from("OK_NAME"), OsString::from("kept")),
        (OsString::from("UNICODE_VALUE"), OsString::from("東京")),
    ];
    let caller_allowlist = caller_values
        .iter()
        .map(|(name, _value)| name.clone())
        .collect::<Vec<_>>();
    let runtime = required_runtime();
    let mut runtime_names = runtime.keys().cloned().collect::<Vec<_>>();
    runtime_names.push(OsString::from("ＳystemRoot"));
    let runtime_reads = RefCell::new(Vec::new());

    let outcome = build_child_environment(
        runtime_names,
        |name: &OsStr| {
            runtime_reads.borrow_mut().push(name.to_os_string());
            runtime.get(name).cloned()
        },
        caller_allowlist,
        caller_values,
    )
    .expect("complete required runtime fixture");

    assert_eq!(
        text_variables(outcome.variables()),
        vec![
            ("COMSPEC".into(), r"C:\Windows\System32\cmd.exe".into()),
            ("OK_NAME".into(), "kept".into()),
            ("SYSTEMROOT".into(), r"C:\Windows".into()),
            ("TEMP".into(), r"C:\Temp".into()),
            ("TMP".into(), r"C:\Tmp".into()),
            ("UNICODE_VALUE".into(), "東京".into()),
            ("WINDIR".into(), r"C:\Windows".into()),
        ]
    );
    assert_eq!(
        runtime_reads.into_inner(),
        vec![
            OsString::from("ComSpec"),
            OsString::from("SystemRoot"),
            OsString::from("TEMP"),
            OsString::from("TMP"),
            OsString::from("WINDIR"),
        ],
        "the invalid Unicode runtime name must never be fetched"
    );
    assert_eq!(outcome.diagnostics().len(), 9);
    assert_eq!(
        outcome
            .diagnostics()
            .iter()
            .filter(|diagnostic| diagnostic.reason == RemovalReason::InvalidName)
            .count(),
        8
    );
    assert_eq!(
        outcome
            .diagnostics()
            .iter()
            .filter(|diagnostic| diagnostic.reason == RemovalReason::InvalidValue)
            .count(),
        1
    );
    assert_eq!(
        outcome
            .diagnostics()
            .iter()
            .filter(|diagnostic| { diagnostic.reason == RemovalReason::CaseInsensitiveCollision })
            .count(),
        0
    );
    assert!(outcome.diagnostics().iter().any(|diagnostic| {
        diagnostic.source == VariableSource::Runtime
            && diagnostic.reason == RemovalReason::InvalidName
    }));

    for diagnostic in outcome.diagnostics() {
        assert!(!diagnostic.name.contains('\0'));
        assert!(!diagnostic.name.contains('\n'));
        assert!(!diagnostic.name.contains('\r'));
        assert!(!diagnostic.name.contains('\u{202e}'));
    }
    assert!(!format!("{:?}", outcome.diagnostics()).contains(VALUE_HONEYTOKEN));
}

#[test]
fn deny_rules_cover_adjacent_provider_package_loader_and_search_path_injection() {
    let blocked = [
        "SERVICE_KEY",
        "OAUTH_CLIENT_ID",
        "SSLKEYLOGFILE",
        "CODEX_HOME",
        "GEMINI_BASE_URL",
        "GITHUB_USER",
        "GITLAB_HOST",
        "REPLICATE_API_BASE",
        "BEDROCK_REGION",
        "COREPACK_HOME",
        "PNPM_HOME",
        "YARN_RC_FILENAME",
        "PIP_INDEX_URL",
        "UV_INDEX_URL",
        "CONDA_PREFIX",
        "HTTP_PROXY",
        "REQUESTS_CA_BUNDLE",
        "LD_DEBUG",
        "LIBRARY_PATH",
        "LUA_PATH",
        "CMAKE_PREFIX_PATH",
        "RUSTC_WRAPPER",
        "COR_ENABLE_PROFILING",
        "COMPLUS_PROFAPI_PROFILERCOMPATIBILITYSETTING",
        "CORECLR_ENABLE_PROFILING",
        "CORECLR_PROFILER",
        "CORECLR_PROFILER_PATH",
        "BASH_FUNC_PAYLOAD",
        "GIT_EXEC_PATH",
        "PERLLIB",
        "PHPRC",
        "PHP_INI_SCAN_DIR",
        "SHELLOPTS",
        "IFS",
        "ZDOTDIR",
    ];
    let runtime = required_runtime();
    let outcome = build_child_environment(
        runtime.keys().cloned().collect::<Vec<_>>(),
        |name: &OsStr| runtime.get(name).cloned(),
        blocked.iter().map(OsString::from).collect::<Vec<_>>(),
        blocked
            .iter()
            .map(|name| (OsString::from(name), OsString::from("blocked")))
            .collect::<Vec<_>>(),
    )
    .expect("complete required runtime fixture");

    assert_eq!(
        text_variables(outcome.variables()),
        expected_required_runtime()
    );
    assert_eq!(outcome.diagnostics().len(), blocked.len());
    for name in blocked {
        assert!(outcome.diagnostics().iter().any(|diagnostic| {
            diagnostic.name == name
                && diagnostic.source == VariableSource::Caller
                && diagnostic.reason == RemovalReason::ForbiddenName
        }));
    }
}

#[test]
fn concatenated_secret_markers_are_blocked_without_matching_safe_lookalikes() {
    const CONCATENATED_HONEYTOKEN: &str = "CONCATENATED-SECRET-HONEYTOKEN";
    let blocked = [
        "SERVICE_APIKEY",
        "SERVICE_AUTHTOKEN",
        "SERVICE_ACCESSTOKEN",
        "SERVICE_REFRESHTOKEN",
        "SERVICE_CLIENTSECRET",
        "SERVICE_PRIVATEKEY",
        "SERVICE_SECRETKEY",
        "SERVICE_PASSWORDHASH",
        "SERVICE_OAUTHCLIENTID",
    ];
    let safe = [
        "MONKEY_COUNT",
        "TOKENIZER_PARALLELISM",
        "AUTHOR_NAME",
        "KEYBOARD_LAYOUT",
        "CLIENT_SIDE_MODE",
    ];
    let caller_values = blocked
        .iter()
        .map(|name| {
            (
                OsString::from(name),
                OsString::from(CONCATENATED_HONEYTOKEN),
            )
        })
        .chain(
            safe.iter()
                .map(|name| (OsString::from(name), OsString::from("safe"))),
        )
        .collect::<Vec<_>>();
    let caller_allowlist = caller_values
        .iter()
        .map(|(name, _value)| name.clone())
        .collect::<Vec<_>>();
    let runtime = required_runtime();

    let outcome = build_child_environment(
        runtime.keys().cloned().collect::<Vec<_>>(),
        |name: &OsStr| runtime.get(name).cloned(),
        caller_allowlist,
        caller_values,
    )
    .expect("complete required runtime fixture");

    let kept_names = outcome
        .variables()
        .iter()
        .map(|(name, _value)| name.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert_eq!(
        kept_names,
        vec![
            "AUTHOR_NAME",
            "CLIENT_SIDE_MODE",
            "COMSPEC",
            "KEYBOARD_LAYOUT",
            "MONKEY_COUNT",
            "SYSTEMROOT",
            "TEMP",
            "TMP",
            "TOKENIZER_PARALLELISM",
            "WINDIR",
        ]
    );
    for (name, value) in outcome.variables() {
        if safe.iter().any(|safe_name| name == safe_name) {
            assert_eq!(value, "safe");
        }
    }
    assert_eq!(outcome.diagnostics().len(), blocked.len());
    assert!(outcome
        .diagnostics()
        .iter()
        .all(|diagnostic| diagnostic.reason == RemovalReason::ForbiddenName));
    assert!(!format!("{:?}", outcome.diagnostics()).contains(CONCATENATED_HONEYTOKEN));
}

#[test]
fn every_required_runtime_variable_rejects_an_empty_value() {
    const NONEMPTY_VALUE_HONEYTOKEN: &str = "REQUIRED-RUNTIME-VALUE-MUST-NOT-LEAK";
    let required_names = ["ComSpec", "SystemRoot", "TEMP", "TMP", "WINDIR"];
    let mut unexpected_successes = Vec::new();

    for empty_name in required_names {
        let result = build_child_environment(
            required_names.map(OsString::from),
            |name: &OsStr| {
                if name == empty_name {
                    Some(OsString::new())
                } else {
                    Some(OsString::from(format!(
                        "{NONEMPTY_VALUE_HONEYTOKEN}-{}",
                        name.to_string_lossy()
                    )))
                }
            },
            Vec::<OsString>::new(),
            Vec::<(OsString, OsString)>::new(),
        );

        match result {
            Err(error) => {
                assert!(error.diagnostics().iter().any(|diagnostic| {
                    diagnostic.name == empty_name
                        && diagnostic.source == VariableSource::Runtime
                        && diagnostic.reason == RemovalReason::InvalidValue
                }));
                assert!(!format!("{error:?}").contains(NONEMPTY_VALUE_HONEYTOKEN));
            }
            Ok(_environment) => unexpected_successes.push(empty_name),
        }
    }

    assert!(
        unexpected_successes.is_empty(),
        "empty required values unexpectedly produced environments: {unexpected_successes:?}"
    );
}

#[test]
fn mixed_unusable_runtime_values_fail_with_names_only_diagnostics() {
    const NUL_VALUE_HONEYTOKEN: &str = "MIXED-NUL-VALUE-MUST-NOT-LEAK";
    const FORBIDDEN_VALUE_HONEYTOKEN: &str = "FORBIDDEN-VALUE-MUST-NOT-BE-READ";
    const SAFE_VALUE_HONEYTOKEN: &str = "SAFE-PARTIAL-VALUE-MUST-NOT-LEAK";
    let reads = RefCell::new(Vec::new());

    let result = build_child_environment(
        ["comspec", "SystemRoot", "TEMP", "tmp", "OPENAI_API_KEY"].map(OsString::from),
        |name: &OsStr| {
            reads.borrow_mut().push(name.to_os_string());
            match name.to_str() {
                Some("comspec") => Some(OsString::new()),
                Some("SystemRoot") => None,
                Some("TEMP") => Some(OsString::from(format!("{NUL_VALUE_HONEYTOKEN}\0suffix"))),
                Some("tmp") => Some(OsString::from(SAFE_VALUE_HONEYTOKEN)),
                Some("OPENAI_API_KEY") => Some(OsString::from(FORBIDDEN_VALUE_HONEYTOKEN)),
                _ => unreachable!("only listed runtime names can be requested"),
            }
        },
        Vec::<OsString>::new(),
        Vec::<(OsString, OsString)>::new(),
    );
    let error = match result {
        Err(error) => error,
        Ok(_environment) => panic!("mixed unusable runtime state must fail closed"),
    };

    assert_eq!(
        reads.into_inner(),
        ["comspec", "SystemRoot", "TEMP", "tmp"].map(OsString::from),
        "forbidden runtime values must never be fetched"
    );
    for (name, reason) in [
        ("comspec", RemovalReason::InvalidValue),
        ("SystemRoot", RemovalReason::RuntimeValueUnavailable),
        ("TEMP", RemovalReason::InvalidValue),
        ("WINDIR", RemovalReason::MissingRequiredRuntimeVariable),
        ("OPENAI_API_KEY", RemovalReason::ForbiddenName),
    ] {
        assert!(error.diagnostics().iter().any(|diagnostic| {
            diagnostic.name == name
                && diagnostic.source == VariableSource::Runtime
                && diagnostic.reason == reason
        }));
    }
    let rendered = format!("{error:?}");
    assert!(!rendered.contains(NUL_VALUE_HONEYTOKEN));
    assert!(!rendered.contains(FORBIDDEN_VALUE_HONEYTOKEN));
    assert!(!rendered.contains(SAFE_VALUE_HONEYTOKEN));
}

#[test]
fn unavailable_and_nul_runtime_values_are_omitted_with_names_only_diagnostics() {
    const RUNTIME_VALUE_HONEYTOKEN: &str = "RUNTIME-NUL-HONEYTOKEN-MUST-NOT-LEAK";
    let reads = RefCell::new(Vec::new());
    let result = build_child_environment(
        ["ComSpec", "SystemRoot", "TEMP", "TMP", "WINDIR"].map(OsString::from),
        |name: &OsStr| {
            reads.borrow_mut().push(name.to_os_string());
            match name.to_str() {
                Some("ComSpec") => Some(OsString::from(r"C:\Windows\System32\cmd.exe")),
                Some("SystemRoot") => None,
                Some("TEMP") => Some(OsString::from(format!(
                    "{RUNTIME_VALUE_HONEYTOKEN}\0suffix"
                ))),
                Some("TMP") => Some(OsString::from(r"C:\safe-temp")),
                Some("WINDIR") => Some(OsString::from(r"C:\Windows")),
                _ => unreachable!("only allowlisted names are read"),
            }
        },
        Vec::<OsString>::new(),
        Vec::<(OsString, OsString)>::new(),
    );
    let error = match result {
        Err(error) => error,
        Ok(_environment) => panic!("invalid required values must not produce an environment"),
    };
    assert_eq!(
        reads.into_inner(),
        vec![
            OsString::from("ComSpec"),
            OsString::from("SystemRoot"),
            OsString::from("TEMP"),
            OsString::from("TMP"),
            OsString::from("WINDIR"),
        ]
    );
    assert!(error.diagnostics().iter().any(|diagnostic| {
        diagnostic.name == "SystemRoot"
            && diagnostic.reason == RemovalReason::RuntimeValueUnavailable
    }));
    assert!(error.diagnostics().iter().any(|diagnostic| {
        diagnostic.name == "TEMP" && diagnostic.reason == RemovalReason::InvalidValue
    }));
    assert!(!format!("{error:?}").contains(RUNTIME_VALUE_HONEYTOKEN));
}

#[test]
fn caller_values_require_positive_admission_and_keep_the_approved_spelling() {
    const UNAPPROVED_HONEYTOKEN: &str = "UNAPPROVED-CALLER-HONEYTOKEN";
    let runtime = BTreeMap::from([
        (
            OsString::from("ComSpec"),
            OsString::from(r"C:\Windows\System32\cmd.exe"),
        ),
        (OsString::from("SystemRoot"), OsString::from(r"C:\Windows")),
        (OsString::from("TEMP"), OsString::from(r"C:\Temp")),
        (OsString::from("TMP"), OsString::from(r"C:\Tmp")),
        (OsString::from("WINDIR"), OsString::from(r"C:\Windows")),
    ]);
    let outcome = build_child_environment(
        runtime.keys().cloned().collect::<Vec<_>>(),
        |name: &OsStr| runtime.get(name).cloned(),
        [
            OsString::from("Prime_Agent_Home"),
            OsString::from("SAFE-MODE.V1"),
            OsString::from("NODE_OPTIONS"),
        ],
        [
            (
                OsString::from("prime_agent_home"),
                OsString::from(r"C:\profile"),
            ),
            (OsString::from("safe-mode.v1"), OsString::from("enabled")),
            (
                OsString::from("UNLISTED_FLAG"),
                OsString::from(UNAPPROVED_HONEYTOKEN),
            ),
            (
                OsString::from("node_options"),
                OsString::from(UNAPPROVED_HONEYTOKEN),
            ),
        ],
    )
    .expect("complete required runtime fixture");

    assert_eq!(
        text_variables(outcome.variables()),
        vec![
            ("COMSPEC".into(), r"C:\Windows\System32\cmd.exe".into()),
            ("Prime_Agent_Home".into(), r"C:\profile".into()),
            ("SAFE-MODE.V1".into(), "enabled".into()),
            ("SYSTEMROOT".into(), r"C:\Windows".into()),
            ("TEMP".into(), r"C:\Temp".into()),
            ("TMP".into(), r"C:\Tmp".into()),
            ("WINDIR".into(), r"C:\Windows".into()),
        ]
    );
    assert!(outcome.diagnostics().iter().any(|diagnostic| {
        diagnostic.name == "UNLISTED_FLAG"
            && diagnostic.source == VariableSource::Caller
            && diagnostic.reason == RemovalReason::NotCallerAllowlisted
    }));
    assert!(outcome.diagnostics().iter().any(|diagnostic| {
        diagnostic.name == "node_options"
            && diagnostic.source == VariableSource::Caller
            && diagnostic.reason == RemovalReason::ForbiddenName
    }));
    assert!(!format!("{:?}", outcome.diagnostics()).contains(UNAPPROVED_HONEYTOKEN));
}

#[test]
fn missing_required_runtime_variables_return_a_names_only_error() {
    let result = build_child_environment(
        [OsString::from("SystemRoot")],
        |name: &OsStr| {
            assert_eq!(name, "SystemRoot");
            Some(OsString::from(r"C:\Windows"))
        },
        Vec::<OsString>::new(),
        Vec::<(OsString, OsString)>::new(),
    );
    let error = match result {
        Err(error) => error,
        Ok(_environment) => {
            panic!("an incomplete required runtime must not produce an environment")
        }
    };

    let missing = error
        .diagnostics()
        .iter()
        .filter(|diagnostic| diagnostic.reason == RemovalReason::MissingRequiredRuntimeVariable)
        .map(|diagnostic| diagnostic.name.as_str())
        .collect::<Vec<_>>();
    assert_eq!(missing, vec!["COMSPEC", "TEMP", "TMP", "WINDIR"]);
    assert!(!format!("{error:?}").contains(r"C:\Windows"));
}

#[test]
fn every_deny_rule_has_runtime_coverage_and_never_fetches_its_value() {
    const DENIED_VALUE_HONEYTOKEN: &str = "DENY-TABLE-RUNTIME-HONEYTOKEN";
    const PROVIDER_PREFIX_CASES: &[&str] = &[
        "ALIBABA_SETTING",
        "ANTHROPIC_SETTING",
        "AWS_SETTING",
        "AZURE_SETTING",
        "BEDROCK_SETTING",
        "BITBUCKET_SETTING",
        "CLAUDE_SETTING",
        "CODEX_SETTING",
        "COHERE_SETTING",
        "DATABRICKS_SETTING",
        "DEEPSEEK_SETTING",
        "FIREWORKS_SETTING",
        "GEMINI_SETTING",
        "GITHUB_SETTING",
        "GITLAB_SETTING",
        "GOOGLE_SETTING",
        "GROQ_SETTING",
        "HF_SETTING",
        "HUGGINGFACE_SETTING",
        "LANGCHAIN_SETTING",
        "LANGSMITH_SETTING",
        "MISTRAL_SETTING",
        "OCI_SETTING",
        "OPENAI_SETTING",
        "OPENROUTER_SETTING",
        "PERPLEXITY_SETTING",
        "REPLICATE_SETTING",
        "STABILITY_SETTING",
        "SUPABASE_SETTING",
        "TOGETHER_SETTING",
        "VERTEX_SETTING",
        "WANDB_SETTING",
        "XAI_SETTING",
    ];
    const DANGEROUS_PREFIX_CASES: &[&str] = &[
        "BASH_FUNC_SETTING",
        "CARGO_SETTING",
        "CMAKE_SETTING",
        "COMPLUS_SETTING",
        "CONDA_SETTING",
        "COREPACK_SETTING",
        "CORECLR_SETTING",
        "COR_SETTING",
        "DOTNET_SETTING",
        "DYLD_SETTING",
        "GIT_SETTING",
        "LD_SETTING",
        "LUA_SETTING",
        "NPM_SETTING",
        "PIP_SETTING",
        "PHP_SETTING",
        "PKG_CONFIG_SETTING",
        "PNPM_SETTING",
        "POETRY_SETTING",
        "PYTHONSETTING",
        "RUSTC_SETTING",
        "SSL_CERT_SETTING",
        "UV_SETTING",
        "YARN_SETTING",
    ];
    const DANGEROUS_EXACT_CASES: &[&str] = &[
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
    const SECRET_SEGMENT_CASES: &[&str] = &[
        "SEGMENT_AUTH_MARKER",
        "SEGMENT_AUTHORIZATION_MARKER",
        "SEGMENT_BEARER_MARKER",
        "SEGMENT_COOKIE_MARKER",
        "SEGMENT_COOKIES_MARKER",
        "SEGMENT_KEY_MARKER",
        "SEGMENT_PASS_MARKER",
        "SEGMENT_PASSWD_MARKER",
        "SEGMENT_SECRET_MARKER",
        "SEGMENT_SECRETS_MARKER",
        "SEGMENT_TOKEN_MARKER",
        "SEGMENT_TOKENS_MARKER",
    ];
    const CONCATENATED_SECRET_CASES: &[&str] = &[
        "COMPOUND_ACCESSKEY_FIELD",
        "COMPOUND_ACCESSTOKEN_FIELD",
        "COMPOUND_APIKEY_FIELD",
        "COMPOUND_APISECRET_FIELD",
        "COMPOUND_AUTHCODE_FIELD",
        "COMPOUND_AUTHTOKEN_FIELD",
        "COMPOUND_BEARERTOKEN_FIELD",
        "COMPOUND_CLIENTSECRET_FIELD",
        "COMPOUND_CREDENTIAL_FIELD",
        "COMPOUND_IDTOKEN_FIELD",
        "COMPOUND_OAUTH_FIELD",
        "COMPOUND_PASSPHRASE_FIELD",
        "COMPOUND_PASSWORD_FIELD",
        "COMPOUND_PRIVATEKEY_FIELD",
        "COMPOUND_REFRESHTOKEN_FIELD",
        "COMPOUND_SECRETKEY_FIELD",
        "COMPOUND_SESSIONCOOKIE_FIELD",
        "COMPOUND_SESSIONTOKEN_FIELD",
    ];

    let denied_names = PROVIDER_PREFIX_CASES
        .iter()
        .chain(DANGEROUS_PREFIX_CASES)
        .chain(DANGEROUS_EXACT_CASES)
        .chain(SECRET_SEGMENT_CASES)
        .chain(CONCATENATED_SECRET_CASES)
        .copied()
        .collect::<Vec<_>>();
    let mut runtime = required_runtime();
    runtime.extend(denied_names.iter().map(|name| {
        (
            OsString::from(name),
            OsString::from(DENIED_VALUE_HONEYTOKEN),
        )
    }));
    assert_eq!(
        runtime.len(),
        denied_names.len() + 5,
        "deny cases must be unique"
    );
    let runtime_reads = RefCell::new(Vec::new());

    let outcome = build_child_environment(
        runtime.keys().cloned().collect::<Vec<_>>(),
        |name: &OsStr| {
            runtime_reads.borrow_mut().push(name.to_os_string());
            runtime.get(name).cloned()
        },
        Vec::<OsString>::new(),
        Vec::<(OsString, OsString)>::new(),
    )
    .expect("all required runtime values are present");

    assert_eq!(
        text_variables(outcome.variables()),
        expected_required_runtime()
    );
    assert_eq!(
        runtime_reads.into_inner(),
        vec![
            OsString::from("ComSpec"),
            OsString::from("SystemRoot"),
            OsString::from("TEMP"),
            OsString::from("TMP"),
            OsString::from("WINDIR"),
        ],
        "no denied runtime value may be fetched"
    );
    assert_eq!(outcome.diagnostics().len(), denied_names.len());
    for name in denied_names {
        assert!(
            outcome.diagnostics().iter().any(|diagnostic| {
                diagnostic.name == name
                    && diagnostic.source == VariableSource::Runtime
                    && diagnostic.reason == RemovalReason::ForbiddenName
            }),
            "missing forbidden-name coverage for {name}"
        );
    }
    assert!(!format!("{:?}", outcome.diagnostics()).contains(DENIED_VALUE_HONEYTOKEN));
}

#[test]
fn every_invalid_runtime_name_is_rejected_before_its_value_is_fetched() {
    const INVALID_NAME_HONEYTOKEN: &str = "INVALID-RUNTIME-NAME-HONEYTOKEN";
    let invalid_names = [
        OsString::new(),
        OsString::from("HAS=EQUALS"),
        OsString::from("NUL\0NAME"),
        OsString::from("LINE\nBREAK"),
        OsString::from("\u{202e}PATH"),
        OsString::from("Straße"),
        OsString::from("ＳystemRoot"),
        non_unicode_name(),
    ];
    let unapproved_ascii_names = [
        OsString::from("1STARTS_WITH_DIGIT"),
        OsString::from("HAS-DASH"),
        OsString::from("HAS.DOT"),
        OsString::from("HAS SPACE"),
    ];
    let mut runtime = required_runtime();
    runtime.extend(
        invalid_names
            .iter()
            .chain(&unapproved_ascii_names)
            .map(|name| (name.clone(), OsString::from(INVALID_NAME_HONEYTOKEN))),
    );
    assert_eq!(
        runtime.len(),
        invalid_names.len() + unapproved_ascii_names.len() + 5,
        "rejected-name cases must be unique"
    );
    let runtime_reads = RefCell::new(Vec::new());

    let outcome = build_child_environment(
        runtime.keys().cloned().collect::<Vec<_>>(),
        |name: &OsStr| {
            runtime_reads.borrow_mut().push(name.to_os_string());
            runtime.get(name).cloned()
        },
        Vec::<OsString>::new(),
        Vec::<(OsString, OsString)>::new(),
    )
    .expect("all required runtime values are present");

    assert_eq!(
        text_variables(outcome.variables()),
        expected_required_runtime()
    );
    assert_eq!(
        runtime_reads.into_inner(),
        vec![
            OsString::from("ComSpec"),
            OsString::from("SystemRoot"),
            OsString::from("TEMP"),
            OsString::from("TMP"),
            OsString::from("WINDIR"),
        ],
        "no invalid runtime value may be fetched"
    );
    assert_eq!(
        outcome.diagnostics().len(),
        invalid_names.len() + unapproved_ascii_names.len()
    );
    assert_eq!(
        outcome
            .diagnostics()
            .iter()
            .filter(|diagnostic| diagnostic.reason == RemovalReason::InvalidName)
            .count(),
        invalid_names.len()
    );
    for name in unapproved_ascii_names {
        assert!(outcome.diagnostics().iter().any(|diagnostic| {
            diagnostic.name == name.to_string_lossy()
                && diagnostic.source == VariableSource::Runtime
                && diagnostic.reason == RemovalReason::NotRuntimeAllowlisted
        }));
    }
    assert!(!format!("{:?}", outcome.diagnostics()).contains(INVALID_NAME_HONEYTOKEN));
}
