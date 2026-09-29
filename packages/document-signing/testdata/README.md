# CZO test signatures

Sources used to pin ASiC DigestMethod URIs. Do not commit downloaded containers, PFX, or private keys.

- Index: https://czo.gov.ua/testexamples
- ASiC-E + DSTU 7564:2014 + CAdES-BES:
  https://czo.gov.ua/download/test_sign/ASiC-E/DSTU-7564/CAdES-BES/test.txt.asice

`META-INF/ASiCManifest001.xml` DigestMethod:

```
http://www.w3.org/2001/04/xmlenc#dstu7564-256
```

`urn:oid:1.2.804.2.1.1.1.1.2.2.1` remains a parse fallback for older or non-CZO manifests.

## Verification (Task 10 / SHO-252)

Do not commit downloaded containers or private keys. The CAdES-BES `.p7s` lives inside the ASiC-E sample (`META-INF/signature001.p7s`); VERIFY uses the manifest XML as detached content.

Workspace package tests (preferred):

```bash
pnpm --filter @showzy/document-signing test
```

The package Vitest suite includes the Kupyna WASM smoke and the vendored GOST PKCS#12 OPEN vector. The CZO download VERIFY remains:

```bash
node packages/document-signing/scripts/verify-kep-upgrade.ts
```

A new DSTU 4145 + Kupyna PKCS#12 is a release gate, not covered by these scripts.
