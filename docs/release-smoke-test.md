# Release smoke test

Every release passes both halves before it is announced. Orders go to the **Paper** account only.

## 1. Automated: `bun run smoke`

`scripts/release-smoke.ts` starts each binary headless on a fresh temporary data directory, with Rithmic off
(`TESSERA_NO_RITHMIC=1`), secrets in a file store of its own (`TESSERA_SECRET_STORE=file`) and Tessera Cloud off
(`TESSERA_CLOUD_URL=`):

| Binary                 | What it proves                                                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tessera-runtime`      | The shipped runtime starts: one ready line, `GET /healthz` answers, the session token opens JSON-RPC, a fresh install lists only paper accounts, and it exits 0 when stdin closes, with no panic in its log. |
| `tessera-test-runtime` | The same runtime on the mock market: it buys 1 NQ at market on Paper, sees the fill and the +1 position, flattens, sees two fills and no position, and exits 0.                                              |

The shipped runtime has no mock market, so the order round trip runs on `tessera-test-runtime`. A failed check prints
`smoke: ✗`, the runtime's last stderr and log lines and, in Actions, an error annotation, and exits 1.

- **Locally:** `bun run smoke` runs main's prebuilt binaries from `~/.cache/tessera/bin` (or `TESSERA_PREBUILT_DIR`)
  when nothing the Rust code reads changed since their commit, and otherwise builds them (debug); `--release` always
  builds them in release. `TESSERA_RUNTIME_BIN` and `TESSERA_TEST_RUNTIME_BIN` name other binaries.
- **In a pull request:** it is the `smoke` step of `bun run check`. CI runs it only when the change touches the Tauri
  shell, the crates, the Cargo files or `scripts/release-smoke.ts`.
- **In a release:** the `Build` workflow, which `Release` calls, runs it on each platform right after
  `bun run tauri:build`, on each runtime a bundle ships: the one in `Tessera.app`, the Windows `tessera-runtime.exe`,
  and on Linux both the `.deb`'s and the extracted AppImage's (which loads the `libssl` and `libcrypto` bundled with
  it). A release publishes only once every platform has passed: no GitHub release and no update otherwise.

## 2. By hand, per platform

Once on a machine (or a clean user account) that has never had Tessera, once on one with the previous release and a
saved login. Use a Rithmic login no other Tessera is signed in to: a second sign-in ends the first one's market data.

### macOS (Apple Silicon)

1. **Fresh install.** Open the release's `.dmg`, drag Tessera to Applications, open it, then System Settings › Privacy &
   Security › Open Anyway. It opens on the Rithmic login.
2. **Connect market data.** Pick the firm and gateway and sign in. A chart opens and prices move during market hours.
3. **Place and flatten a 1-lot on Paper.** In the Trade panel pick **Paper**, size 1, Buy market. Positions shows +1;
   flatten it there. Paper is flat with two fills, and nothing reached the login's own accounts.
4. **Update from the previous release.** Tessera › Check for Updates…. The card offers this version: Update, then
   Restart and update. This version opens (its number is in Settings › App), the saved login reconnects without a
   keychain prompt, and the layout is as it was.

### Windows (x64)

1. **Fresh install.** Run the release's `-setup.exe`; at SmartScreen choose More info, then Run anyway. Tessera opens
   from the Start menu on the Rithmic login.
2. **Market data and a Paper 1-lot:** steps 2 and 3 as on macOS.
3. **Update:** Check for updates in the Tessera menu, then as on macOS. The saved login reconnects from the Credential
   Manager, and the layout is as it was.

### Linux (x86_64)

1. **Fresh install.** The AppImage (`chmod +x` it and run it) and the `.deb` (`sudo apt install ./<file>`), each on a
   machine without Tessera.
2. **Market data and a Paper 1-lot:** steps 2 and 3 as on macOS.
3. **Update:** as on Windows, for the AppImage and the `.deb` (which asks for the password to install). The saved
   login reconnects from the Secret Service.

## 3. Record it

Add the version, each platform checked and who checked it to the release's notes. A failed step blocks the
announcement until it is fixed or the owner says to ship without it.
