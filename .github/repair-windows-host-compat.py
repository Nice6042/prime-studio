from pathlib import Path

path = Path("app/scripts/windows-host-verification/WindowsHostVerification.psm1")
text = path.read_text(encoding="utf-8")

replacements = [
    ("      files = @($entries)\n", "      files = $entries.ToArray()\n", "bundle manifest generic list"),
    ("    commands = @($records)\n", "    commands = $records.ToArray()\n", "source-check generic list"),
    (
        "  $protected = Protect-ExactPath -Text $protected -Path $RepositoryRoot -Replacement '<REPOSITORY_ROOT>' -Count $countRef\n  $protected = Protect-ExactPath -Text $protected -Path $UserProfileRoot -Replacement '<USER_PROFILE>' -Count $countRef\n  $protected = Protect-ExactPath -Text $protected -Path $TempRoot -Replacement '<TEMP>' -Count $countRef\n",
        "  $protected = Protect-ExactPath -Text $protected -Path $RepositoryRoot -Replacement '<REPOSITORY_ROOT>' -Count $countRef\n  $protected = Protect-ExactPath -Text $protected -Path $TempRoot -Replacement '<TEMP>' -Count $countRef\n  $protected = Protect-ExactPath -Text $protected -Path $UserProfileRoot -Replacement '<USER_PROFILE>' -Count $countRef\n",
        "nested path redaction ordering",
    ),
    (
        "  $protected = Add-TextRedaction -Text $protected -Pattern '(?i)\\b([A-Za-z0-9_.-]*(?:authorization|token|secret|password|passphrase|api[_-]?key|access[_-]?key|private[_-]?key|credential|cookie)[A-Za-z0-9_.-]*)\\b\\s*[:=]\\s*(?:\"[^\"]*\"|''[^'']*''|[^\\s,;]+)' -Replacement '$1=<REDACTED>' -Count $countRef\n  $protected = Add-TextRedaction -Text $protected -Pattern '(?i)\\b(?:bearer|basic)\\s+[A-Za-z0-9._~+\\-/=]{12,}' -Replacement '<REDACTED_AUTH>' -Count $countRef\n  $protected = Add-TextRedaction -Text $protected -Pattern '(?is)-----BEGIN (?<kind>(?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?)-----.*?-----END \\k<kind>-----' -Replacement '<REDACTED_PRIVATE_KEY_BLOCK>' -Count $countRef\n  $protected = Add-TextRedaction -Text $protected -Pattern '(?i)\\bhttps?://[^/\\s:@]+:[^/\\s@]+@' -Replacement 'https://<REDACTED_URI_CREDENTIALS>@' -Count $countRef\n",
        "  $protected = Add-TextRedaction -Text $protected -Pattern '(?is)-----BEGIN (?<kind>(?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?)-----.*?-----END \\k<kind>-----' -Replacement '<REDACTED_PRIVATE_KEY_BLOCK>' -Count $countRef\n  $protected = Add-TextRedaction -Text $protected -Pattern '(?i)\\b([A-Za-z0-9_.-]*(?:authorization|token|secret|password|passphrase|api[_-]?key|access[_-]?key|private[_-]?key|credential|cookie)[A-Za-z0-9_.-]*)\\b\\s*[:=]\\s*(?:\"[^\"]*\"|''[^'']*''|[^\\s,;]+)' -Replacement '$1=<REDACTED>' -Count $countRef\n  $protected = Add-TextRedaction -Text $protected -Pattern '(?i)\\b(?:bearer|basic)\\s+[A-Za-z0-9._~+\\-/=]{12,}' -Replacement '<REDACTED_AUTH>' -Count $countRef\n  $protected = Add-TextRedaction -Text $protected -Pattern '(?i)\\bhttps?://[^/\\s:@]+:[^/\\s@]+@' -Replacement 'https://<REDACTED_URI_CREDENTIALS>@' -Count $countRef\n",
        "private key redaction ordering",
    ),
]
for before, after, label in replacements:
    count = text.count(before)
    if count != 1:
        raise SystemExit(f"{label}: expected one anchor, found {count}")
    text = text.replace(before, after)

path.write_text(text, encoding="utf-8", newline="\n")

test_path = Path("app/scripts/windows-host-verification/Test-WindowsHostVerificationKit.ps1")
test_text = test_path.read_text(encoding="utf-8")
test_replacements = [
    (
        "$preflightRoot = Join-Path $testRoot 'preflight'\n",
        "$preflightRoot = Join-Path $testRoot 'preflight'\n$redactionProfileRoot = Join-Path $testRoot 'synthetic-profile'\n$redactionTempRoot = Join-Path $redactionProfileRoot 'nested-temp'\n",
        "synthetic nested path roots",
    ),
    (
        '    "Authorization: Bearer $githubToken",\n    "provider_key=$providerKey",\n',
        '    "Authorization: Bearer $githubToken",\n    "github=$githubToken",\n    "provider_key=$providerKey",\n',
        "GitHub token-shape oracle",
    ),
    (
        '    "privateKey=$privateKeyBlock",\n',
        '    $privateKeyBlock,\n',
        "standalone private-key oracle",
    ),
    (
        '    "profile=$env:USERPROFILE",\n    "temporary=$env:TEMP"\n',
        '    "profile=$redactionProfileRoot",\n    "temporary=$redactionTempRoot"\n',
        "synthetic path evidence",
    ),
    (
        "  [void](New-WindowsHostEvidenceBundle -InputRoot $inputRoot -OutputRoot $bundleA -RepositoryRoot $repositoryRoot -UserProfileRoot $env:USERPROFILE -TempRoot $env:TEMP)\n  [void](New-WindowsHostEvidenceBundle -InputRoot $inputRoot -OutputRoot $bundleB -RepositoryRoot $repositoryRoot -UserProfileRoot $env:USERPROFILE -TempRoot $env:TEMP)\n",
        "  [void](New-WindowsHostEvidenceBundle -InputRoot $inputRoot -OutputRoot $bundleA -RepositoryRoot $repositoryRoot -UserProfileRoot $redactionProfileRoot -TempRoot $redactionTempRoot)\n  [void](New-WindowsHostEvidenceBundle -InputRoot $inputRoot -OutputRoot $bundleB -RepositoryRoot $repositoryRoot -UserProfileRoot $redactionProfileRoot -TempRoot $redactionTempRoot)\n",
        "synthetic path bundling",
    ),
    (
        "  foreach ($forbidden in @($githubToken, $providerKey, $slackToken, $gitlabToken, $npmToken, $huggingFaceToken, $awsSecret, $jwt, $email, $privateKeyBlock, $repositoryRoot, $env:USERPROFILE, $env:TEMP)) {\n",
        "  foreach ($forbidden in @($githubToken, $providerKey, $slackToken, $gitlabToken, $npmToken, $huggingFaceToken, $awsSecret, $jwt, $email, $privateKeyBlock, $repositoryRoot, $redactionProfileRoot, $redactionTempRoot)) {\n",
        "synthetic path forbidden values",
    ),
]
for before, after, label in test_replacements:
    count = test_text.count(before)
    if count != 1:
        raise SystemExit(f"{label}: expected one anchor, found {count}")
    test_text = test_text.replace(before, after)
test_path.write_text(test_text, encoding="utf-8", newline="\n")

print("patched Windows PowerShell compatibility and deterministic redaction oracles")
