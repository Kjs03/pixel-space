// Run once before publishing, so the model is served from the repository.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const url = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
(async () => {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Model download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const zipOffset = bytes.indexOf(Buffer.from([80, 75, 3, 4]));
  if (bytes.length < 1000000 || zipOffset < 0 || zipOffset > 16) throw new Error('Invalid model bundle; existing file was not changed.');
  const directory = path.resolve(__dirname, '../assets/models');
  await fs.mkdir(directory, { recursive: true });
  const target = path.join(directory, 'hand_landmarker.task');
  await fs.writeFile(target + '.download', bytes);
  await fs.rename(target + '.download', target);
  console.log(`${path.relative(path.resolve(__dirname, '..'), target)}: ${bytes.length} bytes`);
  console.log(`SHA-256 ${crypto.createHash('sha256').update(bytes).digest('hex')}`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
