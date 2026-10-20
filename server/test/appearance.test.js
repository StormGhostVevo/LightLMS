import { test } from "node:test";
import assert from "node:assert/strict";
import { contrast, cleanTheme } from "../theme.js";
import { cleanBody } from "../ai.js";
import { start, quizCourse, DARK, PNG, b64 } from "./helpers.js";

test("theme: public to read, admin only to change; colours come in groups and must stay readable", async () => {
  const s = await start();
  const admin = await s.as("admin"),
    author = await s.as("author"),
    out = await s.as(null);
  assert.deepEqual((await out("/api/theme")).body, {
    siteName: "",
    font: "system",
    fontSize: "normal",
    colours: {},
  });
  assert.equal((await author("/api/admin/theme", { method: "PUT", body: { font: "serif" } })).status, 403);
  assert.equal((await out("/api/admin/theme", { method: "PUT", body: { font: "serif" } })).status, 401);

  const bad = async body => (await admin("/api/admin/theme", { method: "PUT", body })).status;
  assert.equal(await bad({ font: "comic-sans" }), 400);
  assert.equal(await bad({ fontSize: "huge" }), 400);
  assert.equal(await bad({ colours: { background: "red" } }), 400); // not a hex colour
  assert.equal(await bad({ colours: { background: "#ffffff", surface: "#ffffff" } }), 400); // half a group
  assert.equal(await bad({ colours: { sparkle: "#ffffff" } }), 400); // unknown key
  assert.equal(await bad({ colours: { ...DARK, text: "#1c2030" } }), 400); // dark text on dark background
  assert.equal(await bad({ colours: { button: "#ffff00", buttonText: "#ffffff" } }), 400); // white on yellow

  const ok = await admin("/api/admin/theme", {
    method: "PUT",
    body: {
      siteName: "Acme <b>Academy</b>",
      font: "serif",
      fontSize: "large",
      colours: { ...DARK, button: "#6f9bff", buttonText: "#0b1020" },
    },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.siteName, "Acme bAcademy/b"); // angle brackets stripped
  assert.equal((await out("/api/theme")).body.font, "serif");
  s.close();
});

test("theme.css is built only from checked values, applies the choices, and resets", async () => {
  const s = await start();
  const admin = await s.as("admin");
  const css = async () => (await s.raw("/theme.css")).text();
  assert.doesNotMatch(await css(), /--bg:/); // default: nothing overridden
  await admin("/api/admin/theme", {
    method: "PUT",
    body: {
      font: "mono",
      fontSize: "small",
      colours: {
        ...DARK,
        button: "#6f9bff",
        buttonText: "#0b1020",
        header: "#000000",
        headerText: "#ffffff",
      },
    },
  });
  const res = await s.raw("/theme.css");
  assert.match(res.headers.get("content-type"), /text\/css/);
  const text = await res.text();
  for (const piece of [
    "--bg:#14171d",
    "--accent:#6f9bff",
    "--accent-text:#0b1020",
    "--header:#000000",
    "--header-text:#ffffff",
    "ui-monospace",
    "font-size:93.75%",
    "color-scheme:dark",
  ])
    assert.ok(text.includes(piece), piece);
  assert.equal((await admin("/api/admin/theme", { method: "DELETE" })).status, 200);
  assert.doesNotMatch(await css(), /--bg:/);
  assert.equal((await s.parse(await s.raw("/api/theme"))).body.font, "system");
  s.close();
});

test("theme: the built-in presets are all readable, and a stored bad theme falls back to the default", async () => {
  const presets = [
    { ...DARK, button: "#6f9bff", buttonText: "#0b1020", header: "#1c212b", headerText: "#e8ebf1" },
    {
      background: "#ffffff",
      surface: "#ffffff",
      text: "#000000",
      link: "#0033cc",
      button: "#000000",
      buttonText: "#ffffff",
      header: "#000000",
      headerText: "#ffffff",
    },
    {
      background: "#faf6ef",
      surface: "#fffdf8",
      text: "#2b2118",
      link: "#9a3d12",
      button: "#b4501b",
      buttonText: "#ffffff",
      header: "#fffdf8",
      headerText: "#2b2118",
    },
    {
      background: "#eef6f9",
      surface: "#ffffff",
      text: "#10272f",
      link: "#0b6a88",
      button: "#0b6a88",
      buttonText: "#ffffff",
      header: "#0b3c4d",
      headerText: "#ffffff",
    },
  ];
  for (const colours of presets) assert.ok(cleanTheme({ colours }).value, JSON.stringify(colours));
  assert.ok(contrast("#000000", "#ffffff") > 20);

  const s = await start();
  s.db
    .prepare("INSERT INTO settings (key, value, updated_at) VALUES ('theme', ?, ?)")
    .run(JSON.stringify({ font: "nope" }), "x");
  assert.equal((await s.parse(await s.raw("/api/theme"))).body.font, "system");
  s.close();
});

test("cover images: authors can add one; it shows for learners; the address is public but unguessable", async () => {
  const s = await start();
  const { author, id } = await quizCourse(s);
  const learner = await s.as("learner");
  assert.equal(
    (await learner(`/api/admin/courses/${id}/image`, { method: "PUT", body: { data: b64(PNG), alt: "x" } }))
      .status,
    403,
  );
  assert.equal((await author(`/api/admin/courses/${id}`)).body.image, null);
  assert.equal(
    (await author(`/api/admin/courses/${id}/image`, { method: "PUT", body: { data: b64(PNG) } })).status,
    400,
  ); // alt text needed
  const up = await author(`/api/admin/courses/${id}/image`, {
    method: "PUT",
    body: { data: b64(PNG), alt: "<b>A</b> hard hat on a desk" },
  });
  assert.equal(up.status, 200);
  assert.match(up.body.url, /^\/media\/[A-Za-z0-9_-]{22}$/);
  assert.equal(up.body.alt, "A hard hat on a desk");

  const img = await s.raw(up.body.url); // no sign-in needed
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/png");
  assert.match(img.headers.get("cache-control"), /immutable/);
  assert.equal(img.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);

  assert.equal((await learner("/api/courses")).body[0].image.url, up.body.url);
  assert.equal((await learner(`/api/courses/${id}`)).body.image.alt, "A hard hat on a desk");
  assert.equal((await author(`/api/admin/courses/${id}`)).body.image.url, up.body.url);
  assert.equal((await author("/api/admin/courses")).body.find(c => c.id === id).image.url, up.body.url);
  assert.equal((await s.raw("/media/not-a-real-key")).status, 404);
  s.close();
});

test("cover images: only real images are accepted, size is limited, decorative needs no alt", async () => {
  const s = await start();
  const { author, id } = await quizCourse(s);
  const put = body => author(`/api/admin/courses/${id}/image`, { method: "PUT", body });
  assert.equal(
    (
      await put({
        data: b64(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>")),
        alt: "x",
      })
    ).status,
    400,
  ); // SVG refused
  assert.equal(
    (await put({ data: b64(Buffer.from("just some text pretending to be a picture")), alt: "x" })).status,
    400,
  );
  assert.equal((await put({ data: "not base64!!", alt: "x" })).status, 400);
  assert.equal((await put({ alt: "x" })).status, 400);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);
  const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2 * 1024 * 1024)]);
  assert.equal((await put({ data: b64(big), alt: "x" })).status, 413);
  const dec = await put({ data: b64(jpeg), decorative: true });
  assert.deepEqual([dec.status, dec.body.alt], [200, ""]);
  assert.equal((await s.raw(dec.body.url)).headers.get("content-type"), "image/jpeg"); // type comes from the bytes
  s.close();
});

test("cover images: replacing or removing deletes the old file; deleting a draft course deletes its image", async () => {
  const s = await start();
  const { author, id } = await quizCourse(s);
  const put = () =>
    author(`/api/admin/courses/${id}/image`, { method: "PUT", body: { data: b64(PNG), alt: "Cover" } });
  const first = (await put()).body.url,
    second = (await put()).body.url;
  assert.notEqual(first, second);
  assert.equal((await s.raw(first)).status, 404);
  assert.equal((await s.raw(second)).status, 200);
  assert.equal(s.db.prepare("SELECT COUNT(*) FROM images").pluck().get(), 1);
  assert.equal((await author(`/api/admin/courses/${id}/image`, { method: "DELETE", body: {} })).status, 204);
  assert.equal((await s.raw(second)).status, 404);
  assert.equal((await author(`/api/admin/courses/${id}`)).body.image, null);

  await put();
  await author(`/api/admin/courses/${id}/unpublish`, { method: "POST", body: {} });
  await author(`/api/admin/courses/${id}`, { method: "DELETE" });
  assert.equal(s.db.prepare("SELECT COUNT(*) FROM images").pluck().get(), 0);
  s.close();
});

const KEY22 = "AAAAAAAAAAAAAAAAAAAAAA";

test("lesson HTML: only this site's own images survive; everything else about an image is stripped", () => {
  const ok = cleanBody(
    `<p>See:</p><img src="/media/${KEY22}" alt="A hard hat" onerror="alert(1)" width="9999" style="x">`,
  );
  assert.equal(ok, `<p>See:</p><img src="/media/${KEY22}" alt="A hard hat" loading="lazy" />`);
  for (const src of [
    "https://evil.example/x.png",
    "http://evil.example/x.png",
    "//evil.example/x.png",
    "data:image/png;base64,AAAA",
    "javascript:alert(1)",
    "/media/short",
    `/media/${KEY22}/extra`,
    `/media/${KEY22}?x=1`,
    "/other/path.png",
    "",
  ])
    assert.doesNotMatch(cleanBody(`<p>x</p><img src="${src}" alt="y">`), /<img/, src);
  assert.match(cleanBody(`<img src="/media/${KEY22}">`), /alt=""/); // no description counts as decorative
});

test("lesson images: authors upload, place them in lessons, learners see them; covers and lesson images don't clobber each other", async () => {
  const s = await start();
  const { author, id } = await quizCourse(s);
  const learner = await s.as("learner");
  assert.equal(
    (await learner(`/api/admin/courses/${id}/images`, { method: "POST", body: { data: b64(PNG) } })).status,
    403,
  );
  for (const data of [b64(Buffer.from("<svg><script>1</script></svg>")), "not base64!!", undefined])
    assert.equal(
      (await author(`/api/admin/courses/${id}/images`, { method: "POST", body: { data } })).status,
      400,
    );
  assert.equal(
    (await author(`/api/admin/courses/9999/images`, { method: "POST", body: { data: b64(PNG) } })).status,
    404,
  );

  const up = await author(`/api/admin/courses/${id}/images`, { method: "POST", body: { data: b64(PNG) } });
  assert.equal(up.status, 201);
  assert.match(up.body.url, /^\/media\/[A-Za-z0-9_-]{22}$/);
  assert.equal((await s.raw(up.body.url)).headers.get("content-type"), "image/png");

  const lesson = await author(`/api/admin/courses/${id}/lessons`, {
    method: "POST",
    body: { title: "With a picture", body: `<p>Look</p><img src="${up.body.url}" alt="A diagram">` },
  });
  assert.equal(lesson.status, 201);
  assert.match(lesson.body.body, /<img src="\/media\//);
  const view = (await learner(`/api/courses/${id}`)).body;
  assert.match(view.lessons.find(l => l.title === "With a picture").body, /alt="A diagram"/);

  await author(`/api/admin/courses/${id}/image`, { method: "PUT", body: { data: b64(PNG), alt: "Cover" } }); // set, then replace, the cover
  await author(`/api/admin/courses/${id}/image`, { method: "PUT", body: { data: b64(PNG), alt: "Cover 2" } });
  assert.equal((await s.raw(up.body.url)).status, 200); // the lesson image is untouched
  assert.equal(s.db.prepare("SELECT COUNT(*) FROM images WHERE kind = 'lesson'").pluck().get(), 1);
  assert.equal(s.db.prepare("SELECT COUNT(*) FROM images WHERE kind = 'cover'").pluck().get(), 1);
  assert.equal((await author(`/api/admin/courses/${id}/image`, { method: "DELETE", body: {} })).status, 204);
  assert.equal((await s.raw(up.body.url)).status, 200);
  s.close();
});

test("lesson images: unused ones are cleaned up after an hour, never sooner; used ones stay; limits apply", async () => {
  const s = await start();
  const { author, id } = await quizCourse(s);
  const upload = async () =>
    (await author(`/api/admin/courses/${id}/images`, { method: "POST", body: { data: b64(PNG) } })).body.url;
  const [used, oldUnused, freshUnused] = [await upload(), await upload(), await upload()];
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  s.db
    .prepare("UPDATE images SET created_at = ? WHERE key IN (?, ?)")
    .run(old, used.slice(7), oldUnused.slice(7));
  await author(`/api/admin/courses/${id}/lessons`, {
    method: "POST",
    body: { title: "Uses one", body: `<p>x</p><img src="${used}" alt="">` },
  }); // saving a lesson triggers the cleanup
  assert.equal((await s.raw(used)).status, 200); // old but in use
  assert.equal((await s.raw(oldUnused)).status, 404); // old and unused: removed
  assert.equal((await s.raw(freshUnused)).status, 200); // unused but new: the author may still be writing
  const lessonId = s.db.prepare("SELECT id FROM lessons WHERE title = 'Uses one'").pluck().get();
  await author(`/api/admin/lessons/${lessonId}`, { method: "DELETE" });
  assert.equal((await s.raw(used)).status, 404); // the lesson is gone and the image was old, so it goes too
  assert.equal((await s.raw(freshUnused)).status, 200); // the new one is still protected

  for (let i = 0; i < 60; i++)
    s.db
      .prepare(
        "INSERT INTO images (key, course_id, kind, mime, bytes, size, created_at) VALUES (?, ?, 'lesson', 'image/png', ?, 10, ?)",
      )
      .run(`filler${i}`, id, PNG, new Date().toISOString());
  assert.equal(
    (await author(`/api/admin/courses/${id}/images`, { method: "POST", body: { data: b64(PNG) } })).status,
    409,
  );
  s.close();
});
