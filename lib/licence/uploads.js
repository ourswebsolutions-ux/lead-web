// Payment screenshots as files under UPLOAD_DIR (default data/uploads),
// readable only by this server: through a valid action link or the admin
// dashboard. Carried over unchanged from the licence server (server/src/uploads.js).

import fs from 'node:fs/promises';
import path from 'node:path';

const NAME_RE = /^applications\/LF-[0-9A-F]{10}\/[0-9a-f]{16}\.(png|jpg|webp)$/;

class Uploads {
  constructor(dir) {
    this.dir = dir;
  }

  file(name) {
    if (!NAME_RE.test(name)) throw new Error('Invalid upload name');
    return path.join(this.dir, ...name.split('/'));
  }

  async upload(name, data) {
    const file = this.file(name);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, data, { mode: 0o600, flag: 'wx' });
  }

  download(name) {
    return fs.readFile(this.file(name));
  }

  async remove(names) {
    for (const name of names) {
      const file = this.file(name);
      await fs.rm(file, { force: true });
      await fs.rmdir(path.dirname(file)).catch(() => {});
    }
  }
}

export { Uploads };
