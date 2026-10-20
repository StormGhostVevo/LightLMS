# Accessibility

The target is WCAG 2.2 level AA. This page says what is checked automatically on every change, what was fixed when the
checks first ran, and what can only be checked by a person. Nothing here is a claim of full conformance: automated
checks find roughly a third of real problems, and the rest need people using the site.

## Checked automatically (`npm test`, `server/test/accessibility.test.js`)

- **Every screen** is run through axe-core against the WCAG 2.0, 2.1 and 2.2 A and AA rules plus its best-practice rules:
  sign-in, my courses, a course, the quiz (every question type, and with a validation message), grades, account, the
  course editor (every tab, the new-question form for every type, the lesson editor), users, appearance, audit log
  and backups. The result must be empty.
- **The whole app** is run with the real `index.html` and the real router: one `main`, one `nav`, one `header`, one
  `h1` per page, a working skip link, the document language (`en-AU`), a page title that changes on every page, the
  current page marked in the navigation, and focus moved to the content when the page changes.
- **Label in name (WCAG 2.5.3):** every button and link with a spoken name must contain its visible text, so voice
  control ("click Remove link") works. axe's own version of this check needs a real canvas, so it is done by hand in the test.
- **Colour contrast of the built-in palettes:** the light and dark palettes, and the warning notices, are checked for
  4.5:1 on every text and background pairing. Custom themes set by an admin are refused by the server if any pairing is
  below 4.5:1.
- **Focus and zoom:** the focus outline is never removed, motion is reduced when the device asks, and the page can be zoomed.

Each of these was shown to fail when the thing it guards was broken on purpose.

## Found and fixed when the checks were first run

- The learner home page skipped a heading level (a course title directly under the page title).
- Action columns in tables had empty header cells.
- The Account page had two top-level headings, because the embedded password form used a page-level heading.
- The lesson editor's toolbar buttons showed "¶", "• List" and "Unlink" while being named "Paragraph", "Bulleted list"
  and "Remove link", which breaks voice control.
- The new Export data link was named "Download all data held about…", which doesn't contain "Export data".

## Designed in

- Everything works with a keyboard. Controls are real buttons, links, inputs and selects. Nothing relies on hover.
- Every input has a label. Errors appear in an element announced to screen readers (`role="alert"` or `role="status"`).
- Status is never shown by colour alone: results say "Correct" or "Incorrect", badges have words, and contrast
  warnings give the ratio.
- Images need a description (or an explicit "decorative"). The server refuses an upload without one.
- Progress bars use the native `progress` element with a name.
- Light and dark mode follow the device.
- Works from a 375 pixel wide phone upwards.

## Not checked, and needs a person

Do these before relying on the site for people who use assistive technology, and again after big changes.

- **A screen reader** (VoiceOver with Safari, NVDA with Firefox, TalkBack on a phone) on the main journeys: sign in,
  read a lesson, take a quiz, see the result, view a certificate. Automated rules can't tell whether the experience makes sense.
- **Keyboard only, in a real browser:** tab order, that nothing traps focus, that the lesson editor's toolbar and the
  matching question's dropdowns are usable, that the focus outline is visible on every control, and that
  focus isn't hidden behind anything.
- **Zoom to 200% and 400%** (WCAG 1.4.4 and 1.4.10): nothing cut off, no sideways scrolling except in wide tables.
- **Text spacing** (WCAG 1.4.12) and **forced colours** / high-contrast mode.
- **Touch target size** (WCAG 2.5.8, at least 24 by 24 pixels): the small buttons in admin tables are close to the limit
  and should be measured on a real phone.
- **Real rendered contrast**, especially for custom themes and for text over the cover image banner.
- **The printable certificate** with a screen reader and when printed.
- **Plain language and reading level** of lessons: that is up to the authors.
- **The rich-text editor.** It is built on the browser's `contenteditable`, which behaves differently across browsers and
  screen readers. Authors who can't use it need another way to write lessons (none exists yet).

## Known gaps

- No way to write a lesson without the rich-text editor.
- No captions or transcript support for video, because there is no video embedding yet. Add both before adding it.
- Matching questions use dropdowns, which are accessible but slow with many items. Eight is the limit.
- Dates and times follow the browser's locale. There is no language switcher (English only).

## Reporting a problem

Tell the person who runs the site which page, what you were using (browser and any assistive technology), and what
happened. Fixes start with a failing test.
