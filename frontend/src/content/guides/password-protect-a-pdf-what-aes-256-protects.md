---
title: "Password-protecting a PDF: what AES-256 does and does not protect"
description: "Open password versus permissions, what AES-256 really guarantees, why 'no printing' is a request not a lock, and how to protect a PDF on your own device."
summary: "A PDF open password encrypts the whole document with AES-256, so it cannot be read without the password. Permission flags such as no-printing or no-copying are only honoured by well-behaved readers and are not a security control. Protect the file locally, choose a long password, and share it through a separate channel."
tools: ["protect-pdf", "unlock-pdf", "redact-pdf"]
keywords: ["password protect pdf", "encrypt pdf aes 256", "pdf permissions explained", "pdf no printing bypass", "protect pdf without uploading", "pdf owner password vs user password"]
updated: "2026-09-01"
faqs:
  - question: "Can a password-protected PDF be cracked?"
    answer: "AES-256 itself cannot be broken in practice; the password is the weak point. A short or guessable password can be found by trying possibilities at high speed. A long passphrase of several unrelated words makes that infeasible. Nothing about where the file was encrypted changes this — but uploading the document and the password to a website to do the encryption adds a second party who briefly holds both."
  - question: "I set 'no copying' but people can still copy the text. Why?"
    answer: "Permission flags are a request to the reader software, not encryption of the content. Readers that follow the standard honour them; many tools do not, and anyone with the owner password can clear them. If text must not be copyable, it must not be in the file — use redaction."
  - question: "What if I forget the password?"
    answer: "There is no recovery mechanism, on this site or anywhere else — that is what encryption means. Store the password in a password manager before you send the file, and keep an unencrypted copy of the document in a safe place."
---

"Password-protect the PDF" covers two very different mechanisms that happen to live in the same dialog box. One of them is real cryptography. The other is a polite request. Knowing which is which decides whether your document is actually protected.

## Two passwords, two jobs

**The open password** (the standard calls it the *user* password) encrypts the document. Every page, image and font is scrambled with a key derived from the password, and a reader that does not have it sees nothing but an error. This is the mechanism that protects content.

**The owner password** controls *permissions*: whether the document may be printed, whether text may be copied, whether pages may be modified or annotated, whether a form may be filled. A reader opens the file without asking for it, reads the permission flags, and — if it is well behaved — greys out the corresponding menu items.

You can set either, or both. The confusion comes from the second one.

## What the encryption guarantees

Modern PDFs use **AES-256**, the same algorithm that protects bank traffic and disk encryption. Applied to a PDF it means:

- Without the password, the contents cannot be recovered. Not the text, not the images, not the metadata inside the encrypted portion.
- The only attack is guessing the password. AES is not the weak link; the password is.
- A long passphrase — four or five unrelated words, or sixteen-plus random characters — puts guessing out of reach. A pet's name does not.

This is real protection, and it is entirely portable: any standards-compliant reader on any platform will enforce it, because there is no way *not* to.

## What permissions do not guarantee

Permission flags are metadata. They say "please do not allow printing", and a reader decides whether to listen. Adobe's readers listen. Many others do not, and any tool that knows the owner password — or that simply ignores the flags — produces an unrestricted copy. A screenshot defeats "no copying" in one keystroke.

Treat permissions as what they are: a way to stop the honest and the careless from doing something by accident. They do not stop a determined person, and they never did.

If text genuinely must not be extractable, the answer is not a flag. It is to remove the text — see [Redact PDF](/redact-pdf/).

## Why protect the file locally

Consider what happens on an upload-based service: you send the document *and* the password you have just chosen to a server, which encrypts the file and sends it back. For a few seconds — or however long the service keeps uploads — a third party holds both the secret and the thing it protects. That is exactly the pairing encryption exists to keep apart.

[Protect PDF](/protect-pdf/) performs the encryption inside your browser. The key is derived on your device, the file is rewritten with AES-256 on your device, and neither the document nor the password is transmitted anywhere. The completion receipt reports 0 document bytes sent; the browser's Network panel will confirm it.

## Step by step

1. Open [Protect PDF](/protect-pdf/) and choose the document.
2. Set the **open password**. Use a passphrase you will store in a password manager, not one you will try to remember.
3. If you want to restrict printing, copying or editing for well-behaved readers, set the permissions and the **owner password**. Do not reuse the open password for it.
4. Save the protected copy. Keep the original unencrypted version somewhere safe.
5. Send the file and the password by **different channels** — the file by email, the password by message or phone. A password in the same email as the attachment protects nothing.

## Removing protection you are entitled to remove

The [Unlock PDF](/unlock-pdf/) tool opens a protected document with the password you already have and saves an unprotected copy. It does not bypass encryption and cannot recover a lost password; it simply saves you from typing the password every time you open a file you own.

## In one paragraph

Set an open password when the document must not be read by anyone without it; that is real encryption, and its strength is your password's strength. Set permissions when you want to prevent accidental printing or copying, and understand they are advisory. Do both on your own device, keep a plain copy, and never send the password in the same message as the file.
