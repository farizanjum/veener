# Veneer Hands-On Tutorial

Welcome to **Veneer**! This step-by-step guide walks you through setting up Veneer in Obsidian, protecting your first note (including its title and embedded images), unlocking it invisibly, editing in RAM, and using emergency protections.

No cryptography background is needed. In about five minutes, you will know every workflow in the plugin.

---

## Step 1: 60-Second Setup

Before protecting your first note, complete these three quick setup items so your vault is safe and your generated covers look genuinely written by you.

### 1. Enable Veneer
1. Copy `main.js`, `manifest.json`, `styles.css`, and the `assets/` folder into `<your-vault>/.obsidian/plugins/deocy/`.
2. In Obsidian, open **Settings -> Community plugins**, turn on community plugins if prompted, and enable **Veneer**.

### 2. Disable Core "File Recovery" (Required)
Obsidian includes a built-in **File Recovery** plugin that periodically snapshots whatever is currently inside your editor and saves it to disk in plain text. If File Recovery were left on, unlocking a secret note in RAM could quietly write a plaintext backup copy to your hard drive.

1. Open **Settings -> Core plugins**.
2. Scroll down to **File Recovery** and toggle it **OFF**.
3. Veneer checks this automatically and will block unlocking until File Recovery is disabled.

### 3. Set Your Cover Persona & Cover Interests
Veneer never reads your other vault notes to figure out who you are. Instead, you tell it a little bit about your everyday world so its decoy notes match your life.

1. Open **Settings -> Veneer**.
2. **Cover persona:** Type a single natural line describing what you do (for example: `"backend developer who plays cricket and cooks on weekends"` or `"product designer working on mobile apps"`).
3. **Cover interests:** Enter a few comma-separated everyday topics (for example: `"coffee, home lab, running, sci-fi books"`).
4. **Decoy model (Optional but Recommended):** Under **Decoy model**, click **Download model** to grab the default on-device model (**Qwen3 0.6B**, ~378 MB) or a larger model if you have a dedicated GPU. It downloads once with pause/resume support and runs 100% offline from then on. (If you skip downloading a model, all 12 built-in cover templates still work instantly!)

---

## Step 2: Protecting Your First Note (Text, Title & Images)

Let's create a test note to see how Veneer hides your text, your filename, and even your pasted screenshots.

1. Create a new note in Obsidian titled `Q4 Acquisition Strategy`.
2. Write a few paragraphs of private text inside it. If you want to test image hiding, paste or embed a screenshot in the note using standard Obsidian syntax, such as `![[Pasted image.png]]`.
3. Press `Ctrl+P` (or `Cmd+P` on macOS) to open the Command Palette, type **`Veneer: Protect this note`**, and press `Enter`. *(You can also right-click the note in the File Explorer sidebar and click **Protect this note**.)*

### Inside the "Protect this note" Wizard:
1. **Cover source:**
   - Choose **`Generate cover (on-device)`** if you downloaded a local model, or **`Template (instant)`** to pick from 12 built-in covers (grocery list, meeting notes, debug log, workout log, and more), or **`Write my own`**.
2. **Cover type & Cover length (when generating on-device):**
   - Leave **Cover type** on **`Auto`** so Veneer picks a note style that matches your persona.
   - Pick a **Cover length**:
     - **`Auto (match note size)`**: Automatically matches the word count of your real note so a long private document gets an equally substantial cover.
     - **`Short (~50 words, <1s)`**: Quick scratchpad note or checklist.
     - **`Medium (~200 words, ~2s)`**: Standard meeting note or daily log.
     - **`Long (~500 words, ~5s)`**: Detailed multi-section cover note (generates in ~4 seconds on Windows GPUs via Vulkan acceleration).
   - Click **Generate** to preview the decoy text right in the wizard. You can click **Generate** again or edit the preview box directly until you like how it reads.
3. **Password:**
   - Enter a password for this note and repeat it in **Password again**. Use the **Show / Hide** button if you want to verify what you typed.
4. Click **Protect**.

### What Just Happened Behind the Scenes?
- **Your note body** now shows the mundane cover text (for example, a grocery list or bug triage log).
- **Your note title (`Q4 Acquisition Strategy`)** was encrypted inside the payload, and the file on disk was automatically renamed to match the first heading of your cover (for example, `Weekend Errands.md`). Anyone glancing at your sidebar sees only `Weekend Errands`.
- **Your embedded images (`![[Pasted image.png]]`)** were read, encrypted into the AES-256-GCM payload, and deleted from your vault folder on disk so no loose image files give away your secret.
- **Your encrypted payload** is stored inside a quiet YAML frontmatter property named `draft_cache`, padded to 4 KB blocks, with invisible file-size padding so the file on disk looks completely normal.

---

## Step 3: Unlocking Your Note (Two Ways)

When you open your protected note, it looks like an ordinary cover note. Even the bottom-right status bar shows a plain word, character, and line count (`34 words | 210 chars | 6 lines`) with zero labels indicating that a cover is active.

You have two ways to unlock it:

### Way A: The Stealth Inline Way (`;;password` + `Enter`)
This is the primary way to unlock a note when someone might be nearby, because no password dialog ever pops up on screen.

1. Click at the **start of any line** in the note (line 1, an empty line at the bottom, or the beginning of any paragraph).
2. Type `;;` followed immediately by your password (for example, `;;correcthorsebatterystaple`).
   - **Why nothing appears in the editor:** As soon as you type the second `;`, Veneer's CodeMirror 6 `transactionFilter` intercepts your keystrokes. Not a single character of `;;` or your password ever touches the note text, the screen, or the undo history.
   - **Subtle status bar feedback:** Glance at the bottom-right status bar while typing. You will see subtle `••••` dots appear for each character after `;;`, confirming that Veneer is capturing your password. (You can use `Backspace` normally if you make a typo, or press `Escape` to cancel.)
3. Press **`Enter`** (or **`Space`**) to submit.
4. After a brief moment (~300 ms while Argon2id derives your encryption key), your real note text, your real title (`Q4 Acquisition Strategy`), and your hidden images appear in RAM!
   - *Note:* If you type the wrong password, nothing happens at all: no error banner, no screen shake, and no sound. An onlooker cannot tell a failed unlock occurred.

### Way B: The Command Palette Popup (`Veneer: Unlock this note`)
If you are working alone and prefer a traditional password box with a visibility toggle:

1. Press `Ctrl+P` and run **`Veneer: Unlock this note`**.
2. Type your password into the popup modal.
3. Click **`Show`** (which toggles to **`Hide`**) if you want to visually check your password before pressing **`Enter`** or clicking **`Unlock`**.

---

## Step 4: Working While Unlocked & Editing the Cover While Locked

### Working While Unlocked (In RAM)
While the status bar says **`(real)`**, you can edit your secret note just like any other Obsidian note:
- **Automatic encrypted saves:** Whenever you pause typing or Obsidian triggers an auto-save, Veneer intercepts the save in memory, re-encrypts your updated text with a fresh AES-256-GCM nonce, and writes only the cover text + updated `draft_cache` frontmatter to disk. Your plaintext never touches the hard drive.
- **Pasting new screenshots:** If you paste or drag a new image (`![[new-chart.png]]`) into the note while unlocked, Veneer automatically absorbs the image into the encrypted payload on the next save, deletes the unencrypted image file from the vault folder, and displays it inline from a RAM `blob:` URL.

### Editing the Cover Note While Locked
What if you want to add an item to your decoy grocery list while the note is locked (`(cover)`)?
- Just type directly into the cover note!
- Because you did not start with `;;`, your edits are saved to the visible decoy body while your encrypted `draft_cache` payload remains completely intact underneath. Editing the cover while locked will never corrupt your real note or break your password.

---

## Step 5: Auto-Masking & The `Ctrl+Shift+X` Panic Key

You never have to remember to manually lock your note before walking away from your desk. Veneer watches for every common moment your screen might become exposed and masks the note back to its cover automatically:

1. **Switching Tabs or Panes:** Click another tab or open another file in Obsidian, and your unlocked note immediately masks back to its cover.
2. **Alt-Tabbing / Window Blur:** Click outside Obsidian (for example, switching to a browser or Slack), and Veneer masks the note within 150 ms.
3. **60-Second Idle Timer:** Stop typing or moving the cursor for 60 seconds (configurable in **Settings -> Veneer**), and the note re-masks itself.
4. **OS Screen Lock or Sleep:** Locking your computer (`Win+L`) or closing your laptop lid masks all unlocked notes immediately.
5. **The `Ctrl+Shift+X` Panic Key:** Need to hide everything right now? Press **`Ctrl+Shift+X`** (or run `Veneer: Panic: mask all protected notes`). Every open protected note across every pane masks in a single frame.

### Why `Ctrl+Z` Cannot Betray You
Whenever a note masks (whether by idle timeout, tab switch, or `Ctrl+Shift+X`), Veneer replaces the editor state with a fresh CodeMirror 6 state that has **zero undo history**, revokes all temporary RAM `blob:` URLs for hidden images, and wipes any text you copied to the clipboard while unlocked. If someone walks up to your laptop and presses `Ctrl+Z` twenty times, nothing happens.

---

## Step 6: Refreshing Covers, Changing Passwords & Unprotecting

Veneer includes three maintenance commands in the Command Palette (`Ctrl+P`):

### 1. Refresh the Decoy Cover (`Veneer: Refresh decoy cover of this note`)
Tired of seeing the same grocery list on a protected note?
- Run **`Veneer: Refresh decoy cover of this note`** while viewing the protected file.
- Veneer generates a brand-new cover, renames the file on disk to match the new cover's title, and keeps your existing password and encrypted payload untouched.

### 2. Change Your Password (`Veneer: Change password of this note`)
Want to rotate a note's password?
- Run **`Veneer: Change password of this note`**.
- Enter your current password, then enter and confirm your new password (both modals include the **`Show / Hide`** button).
- Veneer re-wraps the note's encryption key with your new password.

### 3. Permanently Unprotect a Note (`Veneer: Unprotect this note (decrypt permanently)`)
If a note no longer needs to be hidden and you want to turn it back into a normal plaintext markdown file:
1. Open the protected note and run **`Veneer: Unprotect this note (decrypt permanently)`**.
2. Enter your password in the prompt.
3. Veneer permanently removes the `draft_cache` frontmatter, writes your real markdown body back to disk, **restores your original note filename** (for example, renaming `Weekend Errands.md` back to `Q4 Acquisition Strategy.md`), and **writes all absorbed images back to your vault folder** as normal image files.

---

## Step 7: Emergency Destruction PIN (`;;!PIN`)

For situations where you need an emergency way to permanently destroy all hidden payloads across your entire vault while making it look like nothing happened, Veneer provides a **Destruction PIN**.

### How to Set Your Destruction PIN
1. Press `Ctrl+P` and run **`Veneer: Set destruction PIN`** (or open **Settings -> Veneer** and click **Set PIN** under **Destruction PIN**).
2. Enter a **4 to 8 digit numeric PIN** (for example, `1234`) and repeat it to confirm.
3. Click **Save PIN**.

### Why It Uses `;;!` Instead of `;;`
Notice that the Destruction PIN trigger is **`;;!`** followed by your digits (for example, `;;!1234`), whereas normal unlocking uses **`;;`**. That extra exclamation mark (`!`) is a deliberate safety guard so you can never accidentally wipe your vault by mistyping a normal password.

### What Happens When You Type `;;!1234` + `Enter`
If you open any protected note, click at the start of any line, and type **`;;!1234`** followed by **`Enter`** (or `Space`):
1. **RAM-First Zeroing:** Veneer immediately zeroes all active encryption keys and plaintext buffers in memory across every open session.
2. **Vault-Wide Crypto-Shredding:** Veneer loops through every protected note registered in your vault, strips the encrypted `draft_cache` frontmatter, and rewrites each file on disk so only the innocent cover text remains.
3. **Registry & Storage Wipe:** Veneer clears the protected-note registry and purges Electron web storage caches.
4. **Zero Visual Tell:** On screen, nothing flashes, no confirmation popup appears, and the cover note stays completely still. To anyone watching over your shoulder, it looks identical to typing an ordinary wrong password, while every secret note in your vault has just become pure, unrecoverable cover text.
