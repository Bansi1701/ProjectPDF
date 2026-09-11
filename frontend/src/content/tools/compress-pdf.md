---
intro: "Use Compress PDF to choose one PDF, reduce its size and compare the result with the original. The result reports the real byte change instead of promising a percentage before examining the document. Filozy starts the document engine only after you choose a file, performs the work inside this tab, and creates a new result for you to save. Your selected document, its filename, and its contents are not sent to Filozy."
howTo:
  - name: "Choose one PDF"
    text: "Select one PDF from the dropzone. Filozy reads it locally and shows the relevant preview or controls before changing anything."
  - name: "Review the settings"
    text: "Enter your upload limit in KB or MB, choose a 30%, 50% or 70% reduction target, or leave it blank for the smallest verified result. Targets are not guarantees."
  - name: "Create and check the result"
    text: "Run the tool, review the reported page count, size, or notes, then save the newly created file while keeping the original."
faqs:
  - question: "Can I compress a PDF to an exact size without changing its appearance?"
    answer: "You can set a maximum size in KB or MB, but not every PDF can reach it without quality loss. Filozy reports whether the target was met and will not remove content or degrade images to force the result."
  - question: "Does compression preserve text, fonts and form fields?"
    answer: "The compressor checks repacked document objects and may compact supported embedded fonts while retaining every glyph ID, shape and spacing. Font compaction requires an all-page pixel and text-position comparison; if verification is unavailable or fails, it falls back to safe repacking. Images and form appearances are not reduced in quality. Signed PDFs and XFA forms remain unchanged. Always review the output in your PDF viewer."
  - question: "Does Compress PDF upload my file?"
    answer: "No. The selected file is opened and processed by code running in this browser tab. Document bytes and filenames are not sent to Filozy."
  - question: "Will this change my original file?"
    answer: "No. Browsers cannot silently overwrite the file you selected. Filozy creates a separate result for you to save or pass to another local tool."
  - question: "What should I check after using Compress PDF?"
    answer: "Check the visible preview and the result summary. The result reports the real byte change instead of promising a percentage before examining the document. Keep the original until the new output has been opened and verified."
  - question: "Do I need an account or subscription?"
    answer: "No account is required for this browser-side tool. It runs on the device and does not use a document-upload allowance or daily server quota."
related:
  - "jpg-to-pdf"
  - "pdf-to-jpg"
  - "pdf-to-markdown"
  - "word-to-pdf"
  - "pdf-to-word"
---

