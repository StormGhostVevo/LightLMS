// Gets a picked image ready to upload: big photos are shrunk so the site stays light. Small images go up unchanged.
const MAX_WIDTH = 1280,
  SHRINK_ABOVE = 400 * 1024,
  MAX_BYTES = 2 * 1024 * 1024;

const toBase64 = blob =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = () => reject(new Error("Couldn't read that file."));
    r.readAsDataURL(blob);
  });

export async function prepareImage(file) {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type))
    throw new Error("Choose a PNG, JPEG, WebP or GIF image.");
  let blob = file;
  if (file.size > SHRINK_ABOVE && file.type !== "image/gif") {
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, MAX_WIDTH / bmp.width);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const smaller = await new Promise(res => canvas.toBlob(res, "image/webp", 0.85));
      if (smaller && smaller.size < file.size) blob = smaller;
    } catch {
      /* keep the original if it can't be shrunk */
    }
  }
  if (blob.size > MAX_BYTES)
    throw new Error("That image is over 2 MB even after shrinking. Try a smaller one.");
  return toBase64(blob);
}
