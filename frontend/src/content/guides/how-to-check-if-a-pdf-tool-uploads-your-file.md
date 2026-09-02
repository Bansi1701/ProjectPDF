---
title: "How to check whether a PDF tool uploads your file"
description: "A five-minute test with your browser's developer tools that shows what any free PDF site sends to its servers — and what a local tool looks like instead."
summary: "Open the browser's Network panel before you choose a file. If the tool uploads, a request roughly the size of your document appears the moment you pick it or press Run. A tool that processes locally shows only its own scripts and engine files — never the document."
tools: ["merge-pdf", "compress-pdf"]
keywords: ["does ilovepdf upload files", "is smallpdf safe", "pdf tool privacy test", "check if website uploads file", "developer tools network tab", "client-side pdf tools"]
updated: "2026-09-01"
faqs:
  - question: "If the site uses HTTPS, isn't my file private anyway?"
    answer: "HTTPS protects the file in transit between you and the server. It says nothing about what the server does once it has the file. Encryption in transit and never uploading are different promises; only the second one keeps the document on your device."
  - question: "What if the request appears only when I click Download?"
    answer: "Some services upload at the last step rather than on selection. Keep the Network panel open through the whole job, including the download. A local tool never shows a request carrying the document at any step."
  - question: "Can this test see everything a page does?"
    answer: "It sees every HTTP request the page makes, which is where uploads happen. It cannot look inside a native app, and it will not catch a service that stores what you typed into a form. For a PDF tool, the Network panel is the test that matters."
---

Every PDF site on the first page of search results says your files are safe. Some mean *we delete them after an hour*; some mean *we encrypt the upload*; a few mean *we never receive the file at all*. Those are three different promises, and the page copy rarely says which one you are getting. The good news is that you do not have to trust the copy. Your browser can show you.

## The test

You need nothing beyond the browser you already have. The steps are the same for any site, including this one.

1. **Open the tool page**, but do not choose a file yet.
2. **Open the developer tools.** Chrome, Edge and Brave: press `F12`, or `Cmd+Option+I` on a Mac. Firefox: `F12` or `Cmd+Option+I`. Safari: enable *Show features for web developers* in Settings → Advanced, then press `Cmd+Option+I`.
3. **Select the Network panel** and leave it open. Tick *Preserve log* if it is offered, so nothing scrolls away when the page changes.
4. **Now choose your file and run the job** exactly as you normally would, through to the download.
5. **Read the list.** Every request the page made is there, with its destination, method and size.

That is the whole test. What you are looking for is a single question: did any request carry the document?

## What an upload looks like

A genuine upload is hard to miss once you know the shape of it:

- The **method** is `POST` or `PUT`, not `GET`.
- The **size** column is roughly the size of your file. A 4 MB PDF produces a 4 MB request.
- The **destination** is the service's own domain or a storage host (names containing `upload`, `api`, `s3`, `storage`, `blob` are typical).
- It appears **the moment you pick the file or press Run**, and a second, smaller request usually follows to fetch the result.

If you see that, the file left your device. Whatever the deletion policy says happens next happens on someone else's computer.

## What a local tool looks like

A tool that processes the PDF in your browser produces a different picture. There are still requests — nothing runs on nothing — but every one of them is the *tool* being delivered to you, not your *document* being delivered to it:

- Requests are `GET`, for files ending in `.js`, `.wasm`, `.woff2`, `.json` or similar.
- They come from the same site you are on, and their sizes are fixed regardless of your file. The engine is the same size whether you merge a one-page letter or a 300-page scan.
- Nothing of the document's size appears at any step, including download. The download itself is not a request at all: the browser is saving bytes it already has.

On HatePDF you can cross-check the Network panel against the tool's own receipt. Every finished job reports the number of **document bytes sent**, and the figure is 0. The receipt is written by the page, so the panel is the independent witness; they should agree.

## Four things that fool people

**"Files are deleted after one hour."** Reassuring, and often true — and it means the file was uploaded. A deletion policy is a description of what happens to a copy. If there is no copy, no policy is needed.

**"256-bit encryption."** This almost always refers to TLS, the padlock in the address bar. It protects the file on the way to the server, not from the server.

**"Client-side" in the marketing, uploads in the panel.** Some services do part of the work locally (a preview, say) and upload for the real operation. The panel does not care what the page says; watch it through the whole job.

**The page loaded a lot before you picked a file.** That is not an upload. Loading an engine early is a performance choice, not a privacy one. HatePDF deliberately waits until you choose a file before fetching its engines, so the panel stays almost empty until you act — but a site that loads early is not thereby uploading.

## Try it on this site

Open [Merge PDF](/merge-pdf/) with the Network panel showing, choose two files and merge them. You will see the site's own scripts and the PDF engine arrive from this domain, and nothing else. The receipt under the result will say **0 document bytes sent**, and the panel will agree.

Then do the same thing on any other PDF site you use. Now you know what each one's promise actually means.
