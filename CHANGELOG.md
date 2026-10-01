# Changelog

## 2026-10-01 — Portable Interego workflow plugin

A five-skill package adds durable work continuation, live affordance discovery, performance diagnosis, authorized knowledge transfer, and evidence-based retention. Portable builds use the existing Streamable HTTP service; private account builds reuse a verified app binding and avoid a duplicate connection. A versioned, hashed instruction module supports constrained runtimes without enabling additional permissions.

The bootstrap is prepared for Crown; runtime integration and the Architecture Atlas update remain pending because the existing Sites source endpoint is unreachable from the authoring workspace. No hosted deployment is changed by this entry.

Validation: five Node package tests pass, live encrypted continuation persistence/readback succeeds, and independent forward testing preserves unresolved state forks and avoids causal or unaided-retention claims from assisted task scores. Source: `c31b1154881bda6ad9622b27d8256f9619c41c11`.

## 2026-09-29 — Foxxi: what Codex found on #586

Codex reviewed #586 after it merged, and found two of its fixes too broad. Both are narrowed here.

- **A counter is a place in a count** (`src/storyline-course.ts`, P1). #586 took any short text that recurs on a scene's question slides with one number changed for a counter. So stems like "What is 2?" beside "What is 3?" were removed from their questions, and the questions were lost for want of text.
  - Now a counter is a place in a count, joined by a slash or a word ("of", "dari"), in a short text that recurs on a scene's question slides. The count must be the same on all of them, and the place must rise in their order and stay within the count: "Question 3 of 10", "1/10 soal", in whatever language. A number alone ("3/10") still counts.
  - Not counters: stems with no count, times tables ("1 x 5 =" beside "2 x 5 ="), sums, a lone or falling place, a place past its count, counts that differ, and longer texts.
- **Whether a page shows anything is what the page keeps of it** (`src/tool-reading.ts`, P2). #586's `shows()` counted a video, a sound or an embed as something a page shows. The page converter drops them, though. So an iSpring interaction of only a video lost its listing, and notes of only a video left a bare heading. `Reading.shows()` now asks the converter itself: the page's text, or a picture the package holds. An interaction that shows nothing a page keeps is listed as that, apart from one whose file is missing from the package.

Tests: the Storyline test's stems that only look like counters (no count, times tables, falling or lone places, a place past its count, counts that differ); iSpring's video-only interaction and notes, and a missing interaction; Storyline's video-only notes. Mutation checks: 9, all caught (one survivor, counts that differ, made the test stricter).

## 2026-09-29 — Foxxi: what Codex found on #578 to #585

Codex was at its usage limit when #578, #579 and #580 opened. Its reviews were asked for again once it was back, and it reviewed #581 to #585 as they opened. Each finding is fixed here, or answered where the evidence says otherwise.

- **A text input given with its answer keeps how it compares** (#581, `src/course-questions.ts`). `authorQuestion`'s explicit-input form rebuilt a text input from its letter case alone. So `input: { type: 'text', compare: 'exact' }` stored no input, and "C" was still right for "C++". Now the input's `compare`, or the question's own beside it, is kept. The two disagreeing are refused, and so is a `compare` beside an input that is not text.
- **A page that shows a picture is kept** (#583). The readers asked `plainText` whether a page had anything to show, and `plainText` reads no media as text: it answers null. `shows()` (`src/tool-reading.ts`) now answers from the page's text, or a picture or media. Before, iSpring left out an interaction holding a picture, an info slide that is only a picture, and a slide with nothing but notes holding a picture. iSpring and Storyline both dropped notes holding a picture, text and all.
- **A counter is found by recurring** (#585, `src/storyline-course.ts`). A counter was any short run of words around numbers, so "Level 2 requires 3 attempts." or "ISO 9001" could be taken for one, leaving a question with no text.
  - Now a counter is a short text that a scene's question slides share, with only the question's number changed and any other number the same on all: "Question 3 of 10", "1/10 soal", in whatever language. A number alone ("3/10") still counts.
  - Sums whose numbers all differ, a stem repeated unchanged, and longer texts are not counters.
- **An activity beside a course that reads to nothing is listed** (#585, `src/tool-exports.ts`). In a SCORM package of several activities, one beside the courses that has no text of its own was dropped without a word. It is now listed with why. In a package of one activity, that activity is the course it holds, so its launcher page still adds nothing.
- **A fold fits a long page and many questions** (#579, #580, `src/package-import.ts`). The fold took only part of a page longer than a fragment holds, or of a topic with more questions than a check holds, and listed the rest. So a Rise block over 20,000 characters, or a Storyline bank of more than 40 questions, lost what did not fit. Now the fold fits them where it can:
  - a long page becomes parts, split between its paragraphs (a paragraph too long, between words);
  - a topic of many questions becomes topics of as many as a check holds, its pages with the first, each developing what the topic does.

  When fitting would make more than one fold holds (100 topics, 500 fragments), the package folds as before, and what does not fit is listed.
- **A Storyline data file may give its JSON as an object** (#579). `globalProvideData('data', {…})` is read with the literal parser Captivate's reader had, now shared (`literalAt` in `src/tool-reading.ts`), and never run. None of the corpus's 3,250 data files is written this way, but the call accepts it.
- **Answered, not changed:**
  - A Rise table (#578) is a text block whose paragraph is an HTML table, and it was read already. A test now shows it.
  - Rise's `deserialize()` payloads (#578) are not compressed. In 186 real packages of that form, each payload decoded as plain base64 JSON. The `lzwcompress.js` a page ships wraps only the LMS's suspend data (`LMSProxy.SetDataChunk(compress(cache))`).

Tests:
- an explicit text input's `compare`;
- a picture in iSpring's interactions, notes and info slides, and in Storyline's notes;
- counters and texts that only look like them;
- an activity drawn by its script beside a course;
- a fold that fits a long page and a topic of many questions, and one that cannot;
- a Storyline course written as objects;
- a Rise table.

Mutation checks: 25, all caught.

## 2026-09-29 — Foxxi: every course a package holds is read, and a Storyline button as the slide shows it (a review of #579)

Codex could not review #579 (its usage limit), so a separate review ran the Storyline reader over 610 real courses (404 questions kept, 769 pages). It found no grading errors. It found a decoder whose work grew with the square of a file's size, fixed in #583, and six more places where a course lost what it shows. Each is fixed here.

- **Every course a package holds is read** (`src/tool-exports.ts`). The fold read only the shallowest course in a package, and lost whatever else it held without listing it: a second module in a zip of two, or a SCORM package's other activities beside a Storyline course. Now:
  - every course an authoring tool keeps is read in its tool's model, trying folders shallowest first; a course inside another's folder is part of it (a Rise course holding a Storyline block);
  - what a SCORM package holds beside its courses is read first, as any package is, in its order; a page that only launches a course adds nothing;
  - several courses' topics are titled by their course, with their ids under its folder, in the order their folders are listed.

  Each reader takes the file its course starts from (`at`). A reader builds its file lookup only when it finds a course.
- **A button is read as the slide shows it.** Storyline marks any object with a trigger a button: a tab, a free-form choice, a question's own text. The reader skipped them all:
  - 13 free-form questions were left out as "a choice is a picture";
  - questions were kept as their counter ("Question 1 of 3");
  - pages lost 225 button texts of 20 characters or more. Many were navigation; some were content: definitions, method names, a reference list.

  Now a button that takes the learner on is skipped: to another slide, a submit, out of its layer, or out of the course. Any other button's text is read. On a page, a short label that shows nothing more of the slide ("Menu") is not read, and a question's text includes no button's short label.
- **A counter in words is not question text**: "Question 1 of 10", "1/10 soal", "Pertanyaan 1 dari 10", "Q3". A question whose only text is its counter, beside a picture, is left out as a picture.
- **A slide two draws in a scene take from is asked once.**
- **A state group is read as its own state**: the object that shares its id, else the first with text.
- **meta.xml's title is read in one pass.** The first `<project>` tag is found, then read. A 180 KB file of open tags used to take 4.3 seconds.
- **A question about a picture on its slide** is kept. The reader's header now says the picture is not shown. Nothing in Storyline's data tells a question's own picture from the slide's decoration. Of 1,336 question slides in the corpus, 718 show a picture of a tenth of the slide or more, most of them backgrounds and characters, so leaving such questions out would lose far more than it fixes.

The fold's description, the Foxxi README, PERFORMANCE-ARCHITECTURE.md §5 and `docs/skills/foxxi` say so.

Tests: the Storyline reader's test adds two groups:
- what a review of #579 found: buttons on a page and in a question, a counter in words, a bank drawn twice, a state group, a meta.xml of many open tags;
- a package that holds more than one course: a zip of two modules, a SCORM package wrapped in a folder, a SCORM package's other activities.

The iSpring and Captivate tests each read a zip of two courses. Mutation checks: 30, all caught.

## 2026-09-29 — Foxxi: a course Captivate published is read in Captivate's own model

A package Captivate published is a player page its runtime draws each slide into. Read as web pages, it had nothing to fold. The course is one JavaScript object literal the player assigns (`cp.D = cp.model.data = {…}`): `assets/js/CPM.js` beside the Classic runtime (Captivate 8 to 11), `assets/js/project.js` for the new player (12.4 and later). `src/captivate-course.ts` reads it as a literal and never runs it: a function, a call or `new` in it ends the read. The course is titled by its project.txt, else the name the player gives the project, its launch page, or its file.

It reads Classic projects, fixed and responsive, and the new player's, published for SCORM, xAPI or the web. The model was established from real public exports: 813 project.txt files (753 Classic, 8.0.1 to 11.8.3; 59 new, 12.4 to 13.1.1), and the data files of 36 of them.
