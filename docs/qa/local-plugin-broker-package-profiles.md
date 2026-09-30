# Local plugin broker package profiles

The local plugin packager defaults to the `production` profile. This profile writes
`bundle-profile.json` and rejects any package entry for
`mcp/keychain-broker.mjs`. The current broker authenticates access with same-user
filesystem permissions only, so it is not eligible for a production package.

The explicit `qa-broker` profile is for local ChatGPT App QA while the signed
native credential IPC is unfinished. It fails before packaging if the broker
source is missing and fails if the final package entry list does not contain
exactly one broker. Its package manifest records `qa_only: true`,
`authenticated_peer_identity: false`, and `release_eligible: false`.

```sh
# Production is the default and excludes the broker.
node apps/plugin/scripts/package-local-plugin.mjs artifacts/local-plugin/store-nova.tar.gz

# QA only. Never use this artifact as a release candidate.
node apps/plugin/scripts/package-local-plugin.mjs artifacts/local-plugin/store-nova-qa.tar.gz --profile qa-broker
```

`STORENOVA_PLUGIN_PACKAGE_PROFILE=qa-broker` is supported for controlled QA
automation. If the environment and `--profile` disagree, packaging fails.

The profile gate only controls package composition. It does not make the QA
broker safe for release and does not change the default production behavior.
