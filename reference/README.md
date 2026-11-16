# reference/ — real owner-supplied data (not committed)

Everything in this folder except this README is gitignored. It holds the real
exports and screenshots supplied by the owner on 2026-10-09:

```
reference/
├── samples/
│   ├── bank-export-69811362-2026-10-09.xlsx   bank export of the business wallet
│   ├── Active|Overdue|Default|Complete Tab Copy-Paste Example.txt
│   └── Mortgage Information Copy-Paste Example.txt
├── screenshots/   in-game phone & tablet UI (FiveM_*.png)
├── brand/litts-loans-logo.png
└── anonymisation-map.json   real → fake mapping (generated; keep private)
```

Tests never read this folder. They use the anonymised copies in
`tests/fixtures/`, produced by `pnpm fixtures:anonymise`. Re-run that after
adding new real samples here; the mapping file keeps pseudonyms stable.
