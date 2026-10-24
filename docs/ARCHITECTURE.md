# Veneer, Architecture & Implementation Plan

**Display name:** Veneer (plugin ID / package: `deocy`, decoy text plugin for Obsidian)
**Status:** Design v1, pre-implementation
**Verdict on existence:** No existing Obsidian plugin provides decoy text or plausible deniability (verified across the community registry, GitHub, and forum threads, July 2026). Closest references: Lockbox (idle auto-lock, no deniability), Meld Encrypt (custom encrypted view, our implementation pattern), Flowvault (decoy-password notepad, our conceptual model).

---

## 1. What we are building

A note on disk is a **normal-looking Markdown file**. Its visible body is meaningful **decoy text**. Somewhere in the file (hidden from casual view) lives an encrypted payload holding the **real text**.

- Opening the note shows the decoy. Obsidian renders it natively, it *is* a normal note.
- Typing a secret password inline (default: at the start of any line, after a silent trigger prefix) swaps the editor to the real text.
- Editing works normally; while unlocked, edits re-encrypt in memory on a 600 ms debounce, and every auto-save writes back *decoy + newest completed ciphertext*, never plaintext.
- On inactivity, window blur, tab switch, screen lock, or a panic hotkey, the note instantly re-masks to the decoy.
- On plugin disable, reload, or update, Veneer synchronously sanitizes every open protected view (wiping owned DEK byte arrays, editor undo history, capture state, and preview URLs, and restoring cover titles) and hands the newest already-completed encrypted snapshot back to Obsidian's native editor before `onunload()` returns.

**The one architectural rule everything else serves:** plaintext must never enter Obsidian's native save, search-index, or file-recovery pipelines, including when the plugin is disabled, reloaded, or updated while notes are open. Every design decision below follows from this.

---

## 2. Threat model, honest ceiling

| Adversary | Defeated? | Notes |
|---|---|---|
| Shoulder-surfer glancing at your screen | ✅ | Sees a boring note. |
| Family member / colleague borrowing the unlocked laptop | ✅ | Auto-mask on blur/idle closes the window of exposure. |
| "Snatch and run" thief grabbing the open laptop | ✅ | Blur/lock triggers mask before inspection. |
| Cloud sync provider (Obsidian Sync, git, iCloud) | ✅ (content) | Syncs only decoy + ciphertext blob. Sync metadata (mtime) still leaks *that* the file changes. |
| Nosy/malicious third-party plugin | ⚠️ Partial | Plugins share the Electron process. We minimize exposure (plaintext only in a sandboxed CM6 state, zeroed on lock) but cannot fully defend against a hostile plugin. Audit your installed plugins. |
| Forensic analyst with a disk image | ❌ | The plugin's own existence in `.obsidian/plugins/` reveals the mechanism; OS swap/hibernation may hold plaintext; multi-snapshot analysis (file mtime changes while decoy content doesn't) is a detectable tell. |

**Conclusion:** this is *visual* and *opportunistic* plausible deniability, done as well as Obsidian allows. It is not a nation-state-grade deniable filesystem (that is VeraCrypt/Shufflecake territory). We will state this plainly in the README so users don't over-trust it. See §11 for the forensic-resistance tiers and the duress (self-destruct) design that closes part of this gap.

---

## 3. Storage format (two modes)

### 3.1 Portable mode (default), ciphertext embedded

The `.md` file = decoy plaintext body + one HTML comment at the very bottom:

```markdown
## Grocery ideas

- oats, eggs, spinach
- try that lentil recipe from Ananya
- call plumber about the kitchen tap

<!--deocy:v1:eyJ2IjoxLCJrZGYiOnsiYWxnbyI6ImFyZ29uMmlkIiwic2FsdCI6Ii4uLiIsInRpbWUiOjMsIm1lbSI6NjU1MzZ9LCJjaXBoZXIiOnsiYWxnbyI6ImFlcy0yNTYtZ2NtIiwibm9uY2UiOiIuLi4iLCJjdCI6Ii4uLiJ9LCJkZWtfd3JhcCI6Ii4uLiIsInBhZCI6NDA5Nn0=-->
```

Payload JSON (base64'd):

```json
{
  "v": 1,
  "note_id": "7f3a…",           // random UUID, survives file renames
  "kdf":  { "algo": "argon2id", "salt": "…", "time": 3, "mem": 65536, "par": 1 },
  "cipher": { "algo": "aes-256-gcm", "nonce": "…", "ct": "…" },
  "dek_wrap": "…",               // DEK wrapped by KEK derived from password
  "pad": 4096
}
```

Why this works for cover:
- **Reading mode renders HTML comments as invisible.** Live Preview hides them unless the cursor is inside. To a screen observer, the note is just the decoy.
- Obsidian's search/graph/backlinks read raw disk content → they index the *decoy* (good cover) and ignore the comment (Obsidian strips HTML comments from most metadata extraction).
- The file travels intact through git/sync, no external state to lose.

Tell: anyone who opens the file in a plain text editor sees the blob. Acceptable for the threat model (screen-level observers).

### 3.2 Stealth mode (option), ciphertext externalized

The `.md` file is **100% clean decoy**, byte-identical to a normal note. Payloads live in `.obsidian/plugins/deocy/payloads/<note_id>.enc`, associated via the plugin's registry (path → note_id).

- ✅ Perfect file-level deniability; nothing anomalous in any `.md`.
- ❌ Renaming/moving the note outside Obsidian orphans the payload (registry keeps a path→id map + content-hash fallback).
- ❌ Sync must include the plugin data folder (git users usually sync `.obsidian`; Obsidian Sync can include plugin data).

Default to **portable**; stealth is a per-note setting for users who accept the fragility.

---

## 4. Cryptography

| Choice | Decision | Rationale |
|---|---|---|
| Cipher | **AES-256-GCM** via Web Crypto API | Native, audited, no dependency. Random 96-bit nonce per save, no nonce-reuse risk. (XChaCha20-Poly1305 via libsodium noted as an alternative.) |
| KDF | **Argon2id** via `hash-wasm` (WASM) | Memory-hard; ~300 ms at time=3, mem=64 MiB. |
| Key hierarchy | Per-note random **DEK** (256-bit), wrapped by a **KEK** = Argon2id(password, salt) | Password change = re-wrap DEK only (no bulk re-encrypt). Per-note passwords supported naturally. |
| AAD (authenticated data) | `note_id` only | **Amended in implementation:** binding AAD to the decoy body made legitimate cover edits permanently break unlock (a design bug caught while mapping the save flow). The GCM tag still protects the real text; the decoy needs no integrity guarantee. |
| Length hiding | PKCS#7-pad plaintext up to the next **4 KB** before encryption | Prevents the ciphertext length from leaking the real text's length (a 50-word decoy vs 10,000-word real text would otherwise be an obvious anomaly). |
| Memory hygiene | Owned key buffers in `Uint8Array`; `.fill(0)` on lock, retirement, and late KDF continuation | Veneer tracks and zeroes the `Uint8Array` DEK arrays it owns (session keys, lock copies, and command-derived keys, plus `finally` cleanup) and clears editor undo history. JavaScript strings and internal WebCrypto `CryptoKey` objects are garbage-collected and cannot be deterministically erased from a plugin, and OS swap, hibernation, and crash dumps remain outside its control. |

**Why not honey encryption:** honey encryption requires *every* wrong key to produce a plausible plaintext. With a fixed covertext, a brute-forcer finds exactly two valid keys (decoy, real) and millions of garbage decryptions, they immediately know a two-key system is in use. Our design is *deniable by display* (the adversary never sees ciphertext unless they inspect raw bytes), not *deniable by cryptography*. We do not advertise cryptographic deniability.

---

## 5. The view layer, the heart of the design

We follow the **Meld Encrypt pattern** (verified as the only architecture that keeps plaintext out of Obsidian's pipelines):

```text
MarkdownView prototype patches & shared lifecycle coordinator (src/view/patch.ts, src/view/lifecycle.ts)
├─ setViewData(data, clear): a file carrying a payload loads as its decoy only;
│    the payload block never enters the editor document while Veneer is active
├─ getViewData(): returns decoy + (newest completed pending or original) ciphertext
│    via computeSavedContent, synchronous, so crypto never runs in the save path
├─ save(): syncs this.data through the patched getViewData before delegating,
│    routing writes through the per-vault, per-file lifecycle coordinator
├─ unlock: Argon2id → unwrap DEK → decrypt → setViewData(realText, clear=true)
│    (fresh editor state, no undo history); ciphertext re-computed on a 600 ms debounce
├─ lock: final re-encrypt → coordinated vault.modify(decoy + ciphertext) →
│    setViewData(decoyBody, clear=true) → zero owned DEK arrays → capture buffer reset
└─ unload / reload handoff (onunload & registered patch cleanup, idempotent):
     freeze canonical completed snapshot per TFile → cancel capture & timers →
     zero all tracked owned DEK Uint8Arrays → revoke preview blob: URLs →
     restore cover titles → nativeSetViewData(fullRaw, true) + view.data = fullRaw →
     retain keyless save/load guards until already-submitted writes & retirement drain settle
```

### 5.1 Synchronous unload handoff & durability boundary

When Obsidian disables, reloads, or updates Veneer, `onunload()` cannot `await` asynchronous WebCrypto or disk operations before Obsidian restores native editor behavior. Veneer solves this with a two-part handoff:

1. **Synchronous confidential state retirement:** Before `onunload()` returns, Veneer marks its owner token retiring, cancels `;;` capture buffers and re-encryption timers, zeroes every tracked owned DEK `Uint8Array` (and wipes any late in-flight Argon2id/KDF result on its first continuation), revokes active `blob:` image URLs, restores cover titles, and hydrates every open protected pane (both locked and unlocked) with the full serialized `decoy + newest already-completed ciphertext` via the captured native `setViewData(fullRaw, true)` and `view.data = fullRaw`. Passing `clear = true` wipes CodeMirror undo history so `Ctrl+Z` cannot recover plaintext after disable. If both the native setter and editor fallback fail to prove a view holds the safe document, Veneer marks that view save-blocked rather than permitting an unverified native save.
2. **Keyless cross-reload write barrier:** A shared coordinator (`Symbol.for("veneer.viewLifecycle.v1")`, scoped by `App`/vault and `TFile`) orders any already-submitted host write ahead of the frozen retirement snapshot and subsequent native saves. A newly loaded plugin instance awaits `predecessorReady` before reading or attaching views.
3. **Ordinary unload is not destruction:** Disabling or reloading Veneer never strips encrypted payloads, never clears the protected-note registry, and never deletes staged source images.
4. **Strict durability boundary (unencrypted tail & force quit):** Because no new encryption starts during synchronous unload, edits that have not yet finished encryption at the moment of unload may be lost. Normally that window is the **600 ms** re-encryption debounce; it can be longer if encryption or image staging stalled or failed. If your newest edits matter before you intentionally disable, reload, or update Veneer, run `Veneer: Mask this note (return to cover)` or `Veneer: Panic: mask all protected notes` (`Ctrl+Shift+X`) and confirm masking completed without a failure notice first. Veneer also does not guarantee that a brand-new disk write completes if Obsidian or the OS is force-killed.

Consequences that fall out of this design:

- **Search index, graph view, backlinks, metadata cache** read raw disk files → they only ever see decoy + ciphertext. Real text is unfindable via global search while protected. (Accepted trade-off; documented.)
- **Hover previews** read from disk → show decoy. Safe by design.
- **Reading mode** renders disk content → shows decoy (comment invisible). When unlocked we are in our editing view; switching to reading view re-locks.
- **CM6 decorations alone are NOT sufficient** (verified): decorations can't substitute a document you also need to edit, and anything placed in a standard MarkdownView's document flows into auto-save/recovery. The custom view with save interception is mandatory.

### Setup requirement the plugin must enforce

**Obsidian's File Recovery core plugin snapshots in-memory editor content to disk.** If it's enabled, unlocked plaintext *will* land in `.obsidian/file-recovery/`. On first run, Veneer checks and refuses to unlock notes until the user disables File Recovery (or accepts the risk explicitly in settings). Same onboarding checklist flags: sync configuration, and a warning that other installed plugins can read editor state.

---

## 6. Unlock mechanism, the inline password, done safely

The user's requested mechanism, *type the password as a word somewhere in the note*, is kept, made safe:

**Mechanism: pre-state keystroke capture via `EditorState.transactionFilter`.**

```text
EditorState.transactionFilter.of(tr => {
  // inspect tr.changes for inserted text
  // maintain a rolling capture buffer per view
  // when buffer matches TRIGGER + password chars:
  //     → block those transactions entirely (return [])
  //     → run Argon2id → unlock()
})
```

- The trigger is a configurable prefix, default `;;`, **valid only at the start of a line** (matching the user's "first word of a line" mental model, and making accidental activation in prose essentially impossible).
- Because the filter blocks each keystroke's transaction *before it reaches the document state*, the password is **never displayed, never saved, never in undo history, never synced**. This is the difference between this design and a naive "watch for changes and delete the password after" implementation, which would be a P0 leak.
- Typing is blind (nothing appears on screen). UX aid: a transient dot-counter in the status bar (`••••`) that only appears while capturing and erases itself on success/failure/timeout. On wrong password: **nothing happens**, no error, no modal. An observer sees you type a few invisible keystrokes and continue. No tell.
- Fallback / alternative unlock paths: command-palette command ("Veneer: unlock note") and a configurable hot-chord, both produce the identical unlock path. (A global-keydown "cheat code" that `preventDefault()`s before CodeMirror was evaluated; transactionFilter is strictly stronger because it operates before state application inside the editor itself.)
- Timing: Argon2id takes ~300 ms. This pause is the one unavoidable tell to someone watching your reaction very closely; we do not add any artificial UI around it, so it reads as a momentary editor hiccup at worst.

---

## 7. Lock engine, inactivity and instant masking

**Mask triggers (each independently configurable):**

| Trigger | Default | Implementation |
|---|---|---|
| Idle timeout | **60 s** (range 15-600) | reset by `keydown`, `mousemove` *within the editor leaf*, `wheel`/scroll, `touchstart` (capture-phase listeners on window) |
| Window blur | **On** | `window.onblur`, you alt-tab away, the note masks |
| Tab / note switch | **On** | `active-leaf-change`, `file-open` workspace events |
| Screen lock / sleep | **On** | Electron `powerMonitor` (`lock-screen`, `suspend`, `resume`) via `remote` |
| App quit | Always | `before-quit` → `maskAll` (best effort; force-quit cannot guarantee a new disk write completes or save an unencrypted debounce tail, though plaintext never touches disk) |
| Panic chord | **Ctrl/Cmd+Shift+X** | instant mask of ALL open protected notes |

**On lock, in order:** force save (encrypt current content) → swap editor content to decoy with `addToHistory:false` → wipe CM6 undo history → `DEK.fill(0)` → clear tainted clipboard → drop capture buffer.

**"I was reading, not typing" case:** scrolling and mouse movement within the note count as activity, so active reading keeps the note open. If you stare at the screen motionless for 60 s it masks, this is the deliberate security/UX trade-off; the timeout is configurable per user.

**Clipboard (KeePassXC pattern):** any copy operation originating in an unlocked protected view marks the clipboard *tainted* with a timestamp. On lock or after 30 s, if the clipboard still holds that exact content, it is overwritten with empty text. Clipboard-manager leakage (Ditto etc.) is documented as an OS-level residual risk.

---

## 8. Decoy text system

Decoy generation is a **v1 core feature** (locked user decision): believable cover text is generated **on-device by a small local LLM**. Hand-writing is optional, never required.

**The source-material rule (unchanged, non-negotiable):** the generator never reads the vault, never sees the real note, never sees other notes. "Related to you" comes from **interests you declare once** in settings (e.g., "cricket, cooking, Chennai travel"), never from your content. A model fed your vault would leak your vault's vocabulary into the visible cover.

| Approach | Believability | Status |
|---|---|---|
| **Local LLM generation** (declared interests + decoy type) | High | ✅ **v1 default** |
| Template bank + topic weaving | Medium-high | ✅ Fallback when the model isn't downloaded yet |
| Hand-written by user | Highest | ✅ Optional (wizard path 3) |
| Markov / RAG from the vault |, | ❌ **Forbidden**, leaks names/phrases from private notes into the visible cover |

### 8.1 The on-device generator

**Runtime: wllama (WebAssembly llama.cpp).** Zero native compilation, portable across macOS/Windows/Linux, avoiding node-llama-cpp's Electron ABI problem entirely. Runs inside a Web Worker (Obsidian's UI never freezes), WebGPU-accelerated with a WASM-SIMD CPU fallback. Prior art checked: Smart Connections ships local models in a sandboxed iframe (embeddings); most LLM plugins shell out to an external Ollama server (rejected, no external installs, self-contained plugin).

**Models (Q4_K_M GGUF, hot-linked from Hugging Face at first run):**

- **Primary: Qwen3 4B Instruct** (~2.5 GB, **Apache 2.0**). Outstanding instruction-following for constrained "write a boring note" generation. ~8-15 tok/s CPU-only → a 100-150-token decoy in **10-15 s**; ~25-40 tok/s on WebGPU → **3-5 s**. Fits a 16 GB RAM laptop comfortably.
- **Fallback: Qwen3 1.7B Instruct** (~1.3 GB, Apache 2.0) for lower-end machines, 18-30 tok/s CPU.
- **Why not Gemma 3 4B (user's suggestion):** technically strong, but the Gemma Terms of Use impose custom acceptable-use compliance obligations on redistribution, and Llama's community license has its own restrictions. Qwen3's Apache 2.0 is fully permissive, no legal surface for a community plugin. Quality for this task is equal or better.

**Distribution (community-store compliant):** model weights are never bundled (bundling = store rejection). First use → explicit-consent modal disclosing size → download from Hugging Face with progress UI, HTTP-Range resume, and **SHA-256 verification**. **Amended in implementation:** the expected hash is fetched automatically from Hugging Face's tree API at download time and verified without any user action (the original "user pastes a hash" idea was rejected as bad UX; a corrupted download deletes itself and reports why). `manifest.json` sets `isDesktopOnly: true`; the README discloses the one-time network use per Obsidian developer policy.

**Offline enforcement (layered):** inference runs in a sandboxed Web Worker / `srcdoc` iframe **without** `allow-same-origin`; CSP `connect-src 'none'` on the worker; Electron session permission handlers default-deny everything; no dynamic remote `<script>` injection (a plugin-review red flag). After the one-time download, the plugin makes **zero network calls**.

**Implementation notes (v1):** wllama v3 ships a single `esm/wasm/wllama.wasm` (~7.5 MB), copied into the plugin's `assets/` at build and pinned via `AssetsPathConfig` so no CDN fallback exists; constructor runs with `allowOffline: true`. Completions use the v3 OAI-compatible `createCompletion({ prompt, max_tokens, temperature, top_p })`. Model files live at `.obsidian/plugins/deocy/models/` (in-vault, with a sync-bloat warning in settings) instead of Electron `userData`, so `getResourcePath` works and no file:// question arises. wllama's IndexedDB model cache duplicates the file; accepted and documented.

### 8.2 Prompt-injection & context-hijack safety

Classic injection/hijack attacks need the model to read untrusted content or to have tools/network access. Our generator has neither. Four walls, in depth:

1. **No untrusted input.** The prompt is assembled from a fixed, compiled-in template + the user's own declared interests. Interests are sanitized: max 40 chars each, alphanumeric + spaces only, newlines and instruction-like patterns stripped, max 10 entries. The model never sees note content, real, decoy, or otherwise, and never sees vault file names.
2. **Single-turn, stateless generation.** No chat loop, no memory between generations (KV context reset per run). There is no conversation to hijack. The system prompt is compiled into the plugin (not user-editable) and carries negative constraints: no real person names, no emails, no phone numbers, no URLs, no secrets, mundane tone.
3. **Output validation before acceptance.** Every candidate decoy must pass: length bounds (80-600 words); regex screens for email/phone/URL patterns; and an **n-gram overlap check**, if any 8-word shingle of the candidate matches the real note content (held in memory at protect/regenerate time), the candidate is **rejected and regenerated** with a new seed. Defense-in-depth against the model ever echoing anything sensitive.
4. **Sandbox + resource caps.** Worker/iframe sandbox as in §8.1; hard cap of 400 output tokens; 30 s generation timeout; the model is warmed up lazily on demand (never eagerly on Obsidian startup or settings changes), serialized via a single-flight operation queue (one generation at a time), and auto-unloaded after 5 minutes of inactivity (`DEFAULT_IDLE_UNLOAD_MS`) to free RAM/VRAM; `NativeRuntime` registers synchronous `window` (`pagehide`/`beforeunload`) and `process` (`exit`) `SIGKILL` cleanup hooks while `llama-server.exe` is running so no orphaned GPU/CPU process can survive window close.

**Generator UX:** wizard step 1 offers **Generate cover (recommended)** / **Use a template** / **Write my own**. Generation shows a shimmer with elapsed time, a **Regenerate** button (new seed), and an editable preview before accepting. Regenerating an existing note's cover is one command ("Veneer: refresh decoy"), keeps covers fresh against decoy drift.

### 8.3 Style enforcement (anti-slop)

AI tells are a cover risk: a generated decoy full of em dashes and assistant cliches looks machine-written. Three defenses, all tested:

1. The generation prompt forbids em dashes, semicolons, exclamation marks, and assistant voice ("write like someone jotting a quick note").
2. Output validation rejects any candidate containing em/en dashes or a blocklist of AI cliches (delve, furthermore, moreover, it is important to note, and friends), then regenerates with a fresh draw.
3. The template bank is tested to be dash-free across seeds, and its prose follows the same rule.

### 8.4 Decoy freshness & drift

**Decoy freshness:** because a locked note lets you edit the decoy directly (saves preserve the payload), users can naturally update their cover notes over time. The plugin nudges this: a per-note "decoy last touched" hint in settings.

**Decoy drift (documented tell):** editing the real text updates the file's mtime while the visible decoy is unchanged. A multi-snapshot forensic observer can notice "this file changes but never its content." Mitigations: cover-maintenance nudges; honest documentation. Not solvable within Obsidian's file model.

---

## 9. UI/UX flows

### 9.1 First-run onboarding (once)
1. Welcome page explains the security ceiling in plain language (§2).
2. **Security checklist** with one-click fixes: disable File Recovery ✅ / review sync scope ✅ / warning about other plugins ✅.
3. Set preferences: idle timeout, trigger prefix, panic chord, clipboard clearing, content protection.

### 9.2 Protect a note
- Command "Deocy: protect this note" (or right-click in file explorer).
- Wizard, 3 steps: **(1)** Choose your decoy, **Generate cover (recommended, on-device LLM)**, use a template + topics, or write your own. Live preview of exactly what an observer would see, with Regenerate and edit-before-accept. **(2)** Choose password for this note (+ strength meter; option to reuse a vault-wide password). **(3)** Confirm: the real content moves into the encrypted payload; the note now shows the decoy.
- The note gets no badge, no icon, no ribbon marker in the file explorer, *that is the point.* Protected notes are listed only inside the plugin's own settings pane (optionally hidden behind the password).

### 9.3 Daily use
- Open note → decoy, completely normal.
- Go to any line start, type `;;` + password (blind; status-bar dots) → ~300 ms → real text is there. Edit normally.
- Step away / alt-tab / 60 s idle → decoy is back. Next open shows decoy again.

### 9.4 Panic
- Panic chord from anywhere → every open protected note masks instantly.
- Optional "paranoid display" setting: while any protected note is unlocked, the plugin calls Electron's `win.setContentProtection(true)`, the Obsidian window renders **black** in screenshots, screen shares (Zoom/Teams/Discord), and Windows Recall. Off by default (it also blocks *your own* legitimate screenshots); desktop only.

### 9.5 Failure & edge UX
- Wrong password → silence (no modal, no shake, nothing).
- Forgot password → the note's real content is unrecoverable by design; the decoy remains a normal note. Stated in onboarding.
- Payload tampered (decoy edited externally, AAD mismatch) → unlock fails with a generic "unable to decrypt" notice in settings, never in the note itself.

---

## 10. Edge-case catalog (consolidated, prioritized)

### P0, breaks the security model if unhandled
1. **Password persisting to disk / undo / sync**, solved by `transactionFilter` pre-state capture (§6). A naive "type then delete" implementation leaks; must not ship.
2. **Auto-save of unlocked plaintext**, solved by overriding `getViewData`/`save` (§5). Plaintext never reaches `Vault.modify`.
3. **File Recovery snapshots**, Obsidian's core plugin writes in-memory editor content to disk. Onboarding hard-blocks unlock until disabled (§5).
4. **Search/graph/metadata indexing plaintext**, solved structurally: indexers read disk, disk holds only decoy+ciphertext (§5).
5. **CM6-decoration-only masking**, verified infeasible/insecure; decorations can't protect an editable document. Custom view is mandatory.
6. **Sync uploading plaintext**, impossible by construction once 1-4 hold (only ciphertext ever persists), but onboarding still reviews sync scope.

### P1, leaks under realistic conditions
7. **Window blur / tab switch leaves real text on screen**, lock engine triggers (§7).
8. **Reading without typing masks too aggressively**, scroll/mouse-in-leaf count as activity; configurable timeout.
9. **Ciphertext length leaks real-content length**, 4 KB padding (§4).
10. **RAM / OS swap / hibernation residue**, keys in zeroed `Uint8Array`s; OS-level swap is out of scope and documented (this is why the forensic ceiling in §2 is honest).
11. **Decoy drift / mtime tell**, cover-maintenance nudges; documented limitation (§8).
12. **Multi-snapshot analysis**, documented ceiling (§2).
13. **Other plugins reading unlocked editor state**, minimized (plaintext exists only in our view's CM6 state, and only while unlocked); onboarding warns. Cannot be fully solved inside a shared process.

### P2, hardening & polish
14. **Clipboard residue**, taint-and-clear on lock (§7).
15. **Screenshots / screen share / Windows Recall**, optional `setContentProtection(true)` while unlocked (§9.4).
16. **Export to PDF while unlocked**, guard: block export from an unlocked protected view (mask-first confirmation).
17. **Argon2id timing pause**, accepted; no UI drawn around it (§6).
18. **Hover preview of links to the note**, reads disk → decoy. Safe.
19. **Mobile**, v1 is desktop-only (needs Electron `powerMonitor`/`setContentProtection`, WASM KDF, and desktop-class view overrides). Documented; mobile shows the decoy harmlessly.
20. **Behavioral tells** (always editing one "boring" note), user guidance in docs, not code.

---

## 11. Forensic resistance & duress

### 11.1 The honest ceiling (verbatim for the README)

> **Can this plugin provide forensic-proof deniability?**
> No. Veneer provides application-level obfuscation and forward secrecy, but it cannot defeat OS-level forensics. If your threat model includes state actors, border guards, or forensic analysts seizing your device, you must understand the limits of an Obsidian plugin. While Veneer ensures your plaintext never touches the disk and your keys are zeroed upon entering a Destruction PIN, the operating system itself is a leaky environment. Electron crash dumps, Windows pagefiles, NTFS USN journals, and cloud sync version histories can all leave metadata proving that a protected file existed, or exactly when it was destroyed. Veneer is designed to protect your data from casual snooping, corporate IT, and physical device theft. For forensic-grade plausible deniability, you must use OS-level tools like a VeraCrypt hidden volume combined with a portable, offline installation of Obsidian.

What the plugin **can** achieve, "forensic-resistant": real content cryptographically unrecoverable without the password (crypto-shredding works even against cloud history and SSD remanence), forward secrecy on duress, existence evidence minimized in stealth mode. The last mile, hiding *that anything existed* from a disk-image analyst, belongs to the disk layer (§11.5), not to any app.

### 11.2 Destruction PIN (GrapheneOS-pattern, approved)

Adapted from GrapheneOS's duress credential: theirs crypto-shreds hardware-bound keys in the Titan M2 secure element; ours crypto-shreds the wrapped DEKs. Same principle (NIST SP 800-88 Rev. 1 §2.6): destroy the small key, and every ciphertext copy anywhere, SSD over-provisioned blocks, Volume Shadow Copies, OneDrive history, git, becomes computationally unrecoverable. Overwriting files on modern SSDs is snake oil (wear leveling, TRIM is advisory); destroying keys is mathematics.

- **Scope:** vault-wide. Duress is a whole-context event, one PIN shreds every protected note.
- **Trigger:** typed via the same `;;` inline mechanism (`;;!PIN`), at any note, in any state (locked or unlocked). Silent by design.
- **Execution order (critical):** (1) advance the lifecycle coordinator's destruction generation, quarantine guarded native saves, zero all owned DEK `Uint8Array` buffers, reset CM6 editor states to cover-only with cleared undo history, kill the auto-save/re-encryption loop, and wait for any already-submitted host writes to settle **first**; (2) then perform disk I/O through destruction-authorized queue entries, rewriting each protected `.md` file to cover-only (portable mode) and fencing/deleting stealth payload targets (even though stealth mode is not reachable in the current release), followed by scrubbing Veneer's protected-note registry; (3) **do not touch host-wide storage:** Veneer stores no secrets in browser web storage and never calls Electron's `clearCache()` or `clearStorageData()`, leaving Electron application caches, shared Chromium storage, Obsidian's workspace state, other community plugins' data, and other vaults untouched; (4) the UI response is **byte-identical to a wrong password**, no dialog, no progress bar, nothing. An observer sees a failed unlock.
- **Setup safeguards:** PIN typed twice at setup; explicit, unavoidable legal warning. **Amended in implementation:** the PIN is 4-8 digits, numeric only, stored as salted SHA-256 and verified before any Argon2 attempt. Format separation is the collision guard (word passphrases can never equal a numeric PIN); the original edit-distance check was dropped because real passwords are never stored, leaving nothing to compare against.
- **Guarantees (forward secrecy):** with the wrapped DEKs destroyed and the password uncompromised, no surviving ciphertext copy is recoverable, including copies made before the shred (pre-imaged disk, cloud history).
- **What it cannot hide, the event:** the NTFS USN journal/MFT records deletions at that moment, and cloud history preserves the prior payload-bearing versions (existence, not content). Stated plainly in docs.
- **Legal warning (mandatory at setup):** in 2026, a US federal indictment (*U.S. v. Tunick*, N.D. Ga. 1:25-CR-499, 18 U.S.C. § 2232(a)) charged a traveler whose GrapheneOS duress PIN wiped his phone during a CBP border search. Triggering destruction during a *legal* search can itself be prosecuted. Jurisdiction note (author): **India**, equivalent exposure exists under BNS §238 (formerly IPC §201, causing disappearance of evidence). Per the author's decision, the setup flow shows one accurate, non-blocking warning line and proceeds.

### 11.3 Rejected features (specialist review, with reasoning)

- **Duress-reveal second decoy, REJECTED.** The plugin is open-source; a prepared adversary knows a fake-password feature exists, so a bluff invites escalation. "I panicked and the keys are mathematically destroyed, I *cannot* comply" is a stronger position than "see, this was everything." (VeraCrypt gets away with it only because a hidden volume is indistinguishable from random free space, our mechanism is public.)
- **Wrong-attempt auto-shred, REJECTED.** An availability footgun: toddlers, pocket typing, and snooping friends would destroy your data, while a sophisticated adversary images the disk first and brute-forces offline, making the shred useless. Replaced by **exponential backoff** on failed unlock attempts.
- **Dead-man's switch, REJECTED.** Defeated by clock manipulation; guarantees data loss after a long vacation. Destruction must be an intentional human act.

### 11.4 Residual artifacts & mitigations

| Artifact | Plugin can fix? | Mitigation |
|---|---|---|
| `pagefile.sys` / `hiberfil.sys` (RAM residue) | No (OS-level) | Guidance: disable hibernation; BitLocker encrypts the pagefile |
| Windows Search **AutoSummary** (first 1 KB of indexed files cached in plaintext in `Windows.db`) | Guidance | Hygiene Check walks the user through excluding the vault from indexing |
| Windows Recall (Copilot+ OCR screenshots) | Yes | `setContentProtection(true)` while unlocked; recommend excluding Obsidian in Recall settings |
| Electron Crashpad dumps (crash while unlocked) | No (OS/process-level) | Hygiene warning; documented |
| Chromium LevelDB `.log` / shared web storage | Not used by Veneer | Veneer stores no keys or plaintext in `localStorage` or `IndexedDB` and never calls `clearStorageData()` or `clearCache()`, leaving Obsidian and other plugins' storage untouched |
| `workspace.json` / third-party plugin caches (Omnisearch etc.) | No (shared process) | Hygiene Check warns; recommend a minimal plugin set |
| LNK files, jump lists, thumbnail cache | No (OS-level) | Documented |
| USN journal shred-timing | No | Accepted: forward secrecy ≠ event deniability |
| Cloud version history (payload *existence*) | No | Operational rules §11.6 |

### 11.5 Tier 3, the disk layer (true forensic-grade)

For users whose threat model includes device seizure by a forensic analyst, the docs provide a setup guide: **VeraCrypt hidden volume + portable Obsidian + the real vault inside the hidden volume**; the outer (decoy) volume holds believable notes and gets the password you hand over. BitLocker alone is insufficient, no hidden volumes, its presence is obvious, and passwords can be compelled. Linux alternative: Shufflecake (15 nested hidden volumes). Complementary philosophy (1Password Travel Mode): before a high-risk exposure like a border crossing, remove the sensitive data from the device entirely, data that isn't there can't be compelled.

### 11.6 Operational rules (hard)

1. **Never protect a note that previously existed as plaintext under sync.** OneDrive (30 days/500 versions personal, no selective version purge), Google Drive (30 days/100 versions, purgeable via revisions API), Dropbox (30-180 days), Obsidian Sync (up to 1 year), and git (history rewrite + force-push, caches persist) all retain the old plaintext.
2. If a note was ever plaintext under sync: **pause sync → delete the file → purge the cloud recycle bin / version history via the web UI → recreate as a protected note → resume sync.**
3. Keep File Recovery disabled; re-run the Hygiene Check after installing or removing other plugins.
4. Know your jurisdiction's laws before relying on duress (§11.2 warning).

### 11.7 Hygiene Check (settings feature)

A settings-pane checklist (auto-run at onboarding, re-runnable): File Recovery status; Windows Search vault-exclusion walkthrough; Recall / content-protection recommendation; third-party plugin warning (read-access to editor state); crash-dump and cache hygiene; sync-platform operational reminders; duress PIN configuration status.

---

## 12. Implementation plan

**Stack:** TypeScript (strict), esbuild via the official Obsidian sample plugin template, Web Crypto API, `hash-wasm` (Argon2id), Vitest for unit tests. Target: Obsidian desktop ≥ 1.5.

```text
veener/
├── src/
│   ├── main.ts                  # Plugin entry, command registration, event wiring
│   ├── settings.ts              # Settings schema, model catalog, active model resolver
│   ├── registry.ts              # Protected-note registry and file-rename tracking
│   │
│   ├── crypto/
│   │   ├── cipher.ts            # AES-256-GCM DEK/KEK wrapping and 4 KB block padding
│   │   ├── kdf.ts               # Argon2id key derivation (64 MiB, 3 iterations, p=4)
│   │   ├── payload.ts           # YAML frontmatter (draft_cache) parser & serializer
│   │   ├── images.ts            # Vault image absorption and permanent restoration
│   │   └── random.ts            # CSPRNG salt and 96-bit nonce generation
│   │
│   ├── view/
│   │   ├── session.ts           # Per-view locked/unlocked RAM session & title swap
│   │   ├── patch.ts             # MarkdownView save interception & undo history wipe
│   │   ├── saveDecision.ts      # Save-path routing (locked cover vs. unlocked RAM)
│   │   └── imageWidget.ts       # CodeMirror 6 widget for in-memory blob: images
│   │
│   ├── capture/
│   │   ├── UnlockCapture.ts     # CodeMirror 6 transactionFilter for ;; & ;;! capture
│   │   └── buffer.ts            # Blind inline password/PIN state machine
│   │
│   ├── lock/
│   │   ├── LockEngine.ts        # Idle timer, blur, tab-switch, & Ctrl+Shift+X panic
│   │   ├── backoff.ts           # Silent exponential backoff on failed ;; unlocks
│   │   ├── clipboard.ts         # SHA-256 clipboard tracking and auto-wipe on mask
│   │   └── power.ts             # OS lock/suspend listeners & Electron screen shield
│   │
│   ├── decoy/
│   │   ├── wizard.ts            # Protect-this-note modal wizard & cover length picker
│   │   ├── templates.ts         # 12 built-in parameterized cover templates
│   │   ├── title.ts             # Cover H1 title extraction and safe file renaming
│   │   ├── strength.ts           # Password entropy and crack-time estimator
│   │   └── rng.ts               # Seeded PRNG for deterministic template fills
│   │
│   ├── llm/
│   │   ├── preferredRuntime.ts  # Automatic Vulkan GPU-to-WASM runtime selector
│   │   ├── nativeRuntime.ts     # Local llama-server Vulkan GPU lifecycle manager
│   │   ├── nativeRuntimeNode.ts # Node process spawner & loopback HTTP client
│   │   ├── runtime.ts           # Single-thread wllama WebAssembly fallback runtime
│   │   ├── generator.ts         # Decoy generation pipeline and retry loop
│   │   ├── prompt.ts            # Persona-aware prompts & Auto/Short/Med/Long targets
│   │   ├── validate.ts           # Burstiness, AI cliche, PII, & n-gram overlap checks
│   │   └── download.ts          # Resumable GGUF model downloader with SHA-256 verify
│   │
│   ├── shred/
│   │   ├── duress.ts            # RAM-first emergency ;;!PIN crypto-shredding engine
│   │   ├── pin.ts               # Argon2id Destruction PIN hashing and verification
│   │   └── hygiene.ts           # Core File Recovery & OS security hygiene checks
│   │
│   └── ui/
│       ├── settingsTab.ts       # Plugin settings, model manager, & VeraCrypt guide
│       ├── modals.ts            # Password unlock/change & PIN modals (Show/Hide)
│       ├── downloadModal.ts     # Pause/resume GGUF model download progress modal
│       └── statusBar.ts         # Stealth ;; capture dots & plain word/line counts
│
├── styles.css                   # Plugin modal, wizard, and hygiene check styles
└── test/                        # Vitest unit & integration test suite
```

| Phase | Deliverable | Verification gate |
|---|---|---|
| **0, Scaffold** | Template builds, loads in a dev vault | `npm run build` clean, plugin appears |
| **1, Crypto core** | kdf/cipher/payload + round-trip & tamper unit tests | Vitest green; tampered AAD fails decrypt |
| **2, DecoyView** | Locked decoy display, save interception, payload preservation | Manual QA: edit decoy → quit → reopen → payload intact; disk file never contains plaintext (grep the vault) |
| **3, Unlock capture** | transactionFilter trigger, blind capture, wrong-password silence | QA: password never appears in file, undo, or sync; `;;` mid-prose doesn't trigger |
| **4, Lock engine** | Idle/blur/leaf/power/panic masking, undo wipe, key zeroing, clipboard | QA matrix over every trigger in §7 |
| **5, Decoy system (templates)** | Template bank, topic weaving, protect wizard | Wizard E2E on sample notes |
| **5b, LLM generator** | wllama runtime, consent + download + SHA-256 verify flow, generation + output validation, offline sandbox | QA: zero network calls after download, overlap-rejection test fires on seeded echo, 400-token / 30 s caps enforced, template fallback works with no model downloaded |
| **6, Hardening** | Onboarding checklist, export guard, content protection, Hygiene Check, settings | Checklist gate works; PDF export blocked while unlocked |
| **6b, Duress** | Destruction PIN capture (silent, wrong-password-identical UI), RAM-first shred ordering, protected-file cover-only rewrite, scoped registry scrub (no global Electron cache or web-storage wipe), legal-warning setup flow | QA: post-shred disk grep finds no payload and no plaintext; shred UI indistinguishable from failed unlock; shared Electron storage and other plugins remain untouched |
| **7, Release prep** | Full edge-case test matrix (§10), README with honest threat model, license | Every P0/P1 row has a passing test or a documented acceptance |

**Hard rules for every phase:** no `as any`, no `@ts-ignore`; plaintext must never appear in a log line; every save path test asserts the disk bytes contain no plaintext; plugin unload must synchronously sanitize open views and hand off the newest completed encrypted snapshot without retaining keys or stripping payloads; duress cleanup must remain strictly scoped to Veneer's own sessions, protected files, and registry.

---

## 13. Decisions locked vs. open

**Locked (from this design):** custom view architecture; transactionFilter inline unlock; 4 KB padding; per-note DEK + Argon2id KEK; idle/blur/leaf/power/panic lock triggers; desktop-first. **Confirmed by user:** idle timeout **60 s**; trigger prefix **`;;`** at line start; **LLM-generated decoys in v1** (on-device wllama + Qwen3 4B Instruct, 1.7B fallback, download-on-demand, offline after cache); portable payload default; **display name: Veneer** (package/plugin ID stays `deocy`); GrapheneOS-pattern **Destruction PIN** (vault-wide crypto-shred, silent trigger, RAM-first ordering) with exponential backoff; duress-reveal second decoy, wrong-attempt auto-shred, and dead-man's switch **rejected** (§11.3); Hygiene Check in onboarding; operational rules for sync version history (§11.6).

**Implementation status (v1):** Phases 0-6b built and verified: 72 unit tests green, strict typecheck clean, production build green. Remaining: first-run QA in a live vault (README checklist) and community-store submission. **Confirmed by user:** vault is local-only (no cloud sync); Destruction PIN in v1; portable payload default (stealth per-note later). Amendments made during implementation are marked inline: note_id-only AAD (§4), the prototype-patch save strategy (§5), wllama v3 asset layout and in-vault model dir (§8.1), style enforcement (§8.3), and numeric-only destruction PIN (§11.2).
