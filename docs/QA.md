# Veneer: hands-on test plan

Run this in a live vault. Everything is ordered so failures surface early, where they are easiest to diagnose.

## 0. Safety first

- **Use a throwaway vault.** Create a fresh vault for testing (Obsidian > Open folder as vault > new empty folder). Do not point v0.1 at your real notes.
- **Do not test the destruction PIN on anything you care about.** It is unrecoverable by design.
- If you ever test in your real vault later, back it up first.

## 1. Install

```
cd deocy-text-plugin-obsidian
npm install        # already done if you followed the build
npm run build      # produces main.js + copies assets/
```

Then copy these into the test vault at `<test-vault>/.obsidian/plugins/deocy/` (create the folder):

- `main.js`
- `manifest.json`
- `styles.css`
- `assets/` (the whole folder, contains the wllama wasm)

Start Obsidian with the test vault. Settings > Community plugins > turn on community plugins > enable **Veneer**.

## 2. First-run setup

1. Settings > Core plugins > **File Recovery: off**. Veneer blocks unlocks until this is done. Test that block: protect a note (step 3) before disabling it and try to unlock. You should get one Notice telling you to disable it.
2. Settings > Veneer > **Your cover interests**: add 2-3 bland topics (e.g. `cricket, cooking, goa travel`).
3. Leave the other settings at defaults for the first pass.

## 3. Core flow (templates only, no model yet)

**3.1 Protect.** Make a note with two lines of fake secret text (e.g. `bank locker code 4491` and `meet priya at the old bridge`). Right-click it in the file explorer > **Protect this note**. Pick Template, reroll a few times, set a passphrase twice, Protect.
Expect: the note now shows the cover text.

**3.2 Verify on disk.** Open the same `.md` file in Notepad or VS Code. You should see the cover text and, at the very bottom, one long `<!--deocy:v1:...-->` comment. Search the file for `4491`: **zero hits.** If any plaintext appears here, stop and report.

**3.3 Search and graph.** In Obsidian, search for `4491` and `old bridge`: zero results. This is the plugin working, not a bug.

**3.4 Unlock inline.** Go to the start of an empty line in that note, type `;;` then your password, then space.
Expect: nothing visible while you type (dots count in the status bar if enabled), a short pause (~half a second), then the real text replaces the cover.

**3.5 Wrong password.** Mask (Ctrl+Shift+X), then type `;;wrongpass` + space.
Expect: nothing. No error, no shake. After several wrong tries, attempts start getting silently delayed (backoff).

**3.6 Edit persistence.** Unlock, add a line of real text, wait 5 seconds (the 600 ms re-encryption debounce completes and autosave runs), close the note, reopen it: cover shows. Check the `.md` in Notepad again: still no plaintext. Unlock again: your new line is there. (Before intentionally disabling or updating the plugin, run `Veneer: Mask this note (return to cover)` or press `Ctrl+Shift+X` and confirm masking completed so edits still inside the 600 ms debounce window are encrypted and saved first.)

**3.7 Mask triggers.** Unlock the note, then test each:
- Wait 60 seconds without touching anything: cover returns.
- Unlock, then Alt+Tab to another app: cover returns.
- Unlock, then open a different note: cover returns.
- Unlock, then Ctrl+Shift+X: cover returns instantly.

**3.8 Undo safety.** After any mask, press Ctrl+Z several times.
Expect: the real text never comes back. History was wiped on mask.

**3.9 Clipboard.** Unlock, select a real sentence, Ctrl+C, then mask with the panic key, then paste into Notepad.
Expect: empty (clipboard was wiped because it still held the tainted text).

**3.10 Locked cover edit.** While locked, edit the grocery list itself (add an item). Close and reopen: your edit persisted. Unlock still works. Also test editing the cover while locked, disabling Veneer in **Settings > Community plugins**, pressing `Ctrl+S` (native save), re-enabling Veneer, and unlocking: both your cover edit and your real decrypted note are preserved. This is cover maintenance, and it is supposed to work.

**3.11 Rename.** Rename the note in the file explorer. Unlock still works (identity is not the filename).

**3.12 Refresh cover.** Command palette > `Veneer: Refresh decoy cover of this note`.
Expect: new cover text, unlock still works with the same password.

**3.13 Change password.** Command palette > `Veneer: Change password of this note`. Old password, new password. Old one now fails silently, new one unlocks.

**3.14 Unprotect.** Command palette > `Veneer: Unprotect this note (decrypt permanently)`, enter password.
Expect: the note is plain markdown again. Check the `.md` in Notepad: real text present, payload comment gone.

## 4. Real model (Qwen3, on-device)

**4.1 Download.** Settings > Veneer > Decoy model > **Download model**. ~2.5 GB for the 4B (pick the 1.7B if this laptop is weak). Progress shows in the button. This is the only network call the plugin ever makes. The file verifies itself against Hugging Face's SHA-256 record automatically; the Notice says so when it passes.

**4.2 First generation.** Protect a fresh note, choose **Generate cover (on-device)**, pick a cover type, hit Generate.
Expect: the first run loads the model into RAM (10-30 seconds). After that, a cover takes 3-15 seconds depending on hardware. Regenerate gives a new cover each time.

**4.3 Quality check.** Read the generated cover. It should be mundane, readable, and free of em dashes and assistant-sounding phrases. Your declared interests may show up lightly. Anything weird (emails, phone numbers, URLs) should have been rejected automatically before you ever see it.

**4.4 Offline proof.** After the download finishes, disconnect Wi-Fi. Generate again.
Expect: it still works. That is the offline guarantee, and it is the whole point of a local model.

**4.5 Refresh with the model.** `Veneer: Refresh decoy cover` on an existing protected note now uses the model (the Notice says `llm` as the source).

## 5. Destruction PIN (destructive, test vault only)

**5.1 Set it.** Settings > Veneer > Destruction PIN > Set PIN. Numeric, 4-8 digits, twice.

**5.2 Use it.** Protect one more note with a secret. On any line start in any note, type `;;!` + the PIN + space.
Expect: a brief pause, and nothing else. The screen looks like a failed unlock. Then check:
- Every protected note now shows only its cover, and unlock no longer works.
- The `.md` files in Notepad: `draft_cache` payloads are gone. The notes are pure cover text.
- Settings > Veneer > Protected notes: empty.
- Obsidian workspace layout, other community plugins' settings/caches, and other vaults are completely untouched (duress never wipes Electron application caches or shared web storage).

**5.3 What you just proved.** Even if someone images the disk afterward, there is nothing left to brute-force: the keys and ciphertext are destroyed, not just hidden.

## 6. Poke the edges

- **Plugin disable / reload with an unlocked note open:** Unlock a protected note, add a new line of secret text, wait 1 second (so the 600 ms re-encryption debounce finishes), then open **Settings > Community plugins** and toggle **Veneer** off (or reload the plugin). Verify all four properties:
  1. Before disable finishes, the editor immediately replaces the decrypted note and real title with the cover note and cover title.
  2. Press `Ctrl+Z` repeatedly inside the editor: the secret text and real title never return (undo history was wiped).
  3. Press `Ctrl+S` to trigger Obsidian's native save while Veneer is disabled, then inspect the `.md` file on disk in an external editor: zero plaintext secret or real title appears on disk, and the `draft_cache` YAML frontmatter payload is still present and parseable.
  4. Toggle **Veneer** back on and unlock the note: the file decrypts cleanly to your newest completed edit.
- **Unencrypted tail boundary on immediate unload:** Unlock a note, type a few characters, and immediately disable or reload Veneer within the 600 ms debounce window (or while encryption/image staging is still running). Re-enable and unlock: the note decrypts to the last completed encrypted snapshot, while the unencrypted tail is not guaranteed. Whenever your newest edits matter before intentionally disabling or updating Veneer, run `Veneer: Mask this note (return to cover)` or press `Ctrl+Shift+X` and confirm masking completed without an error notice first.
- **Disable / reload across multiple panes (locked + unlocked):** Open the same protected note in two side-by-side panes. Edit the cover in the locked pane, and make a completed edit in the unlocked pane. Disable Veneer, press `Ctrl+S` in both panes, re-enable Veneer, and unlock: both panes hold the updated cover and decrypt to the newest completed payload without the locked pane overwriting or rolling back the ciphertext.
- **Ordinary notes unaffected:** Keep two ordinary unprotected Markdown notes open alongside your protected note while disabling Veneer, pressing `Ctrl+S`, and re-enabling Veneer. Check both ordinary `.md` files on disk and in the editor: they remain byte-for-byte unchanged.
- Unlock a note, then open Settings and leave it open for 60+ seconds. The note should still mask (idle is global).
- Close Obsidian with a note unlocked, relaunch: cover shows, no plaintext anywhere on disk.
- Type `;;` in the middle of a sentence in a normal note: nothing happens (trigger only fires at line start, and only in protected notes).
- Open the developer console (Ctrl+Shift+I) during a full pass. Warnings from Veneer about skipped re-encryption are benign. Errors are not; report them.

## 7. If something breaks

- Console errors: Ctrl+Shift+I > Console. Copy the red ones.
- Tell me: what you did, what you expected, what happened, the console output, and whether the `.md` on disk looks wrong.
- The most fragile area is the save and unload interception (phase 2 / unload handoff): if a view's native setter and fallback both fail to sanitize the editor during unload, Veneer blocks native saves on that view (`Veneer: refusing native save on a view whose sanitization failed`) rather than writing plaintext to disk. If you ever see real text inside the `.md` file on disk while it should be masked or disabled, treat it as P0 and stop using the plugin until we fix it.
