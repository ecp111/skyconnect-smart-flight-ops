import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { createApp } from "./app.js";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "web", "dist");
const port = Number(process.env.PORT ?? 3000);

const { app } = createApp();
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(join(dist, "index.html")));
}

app.listen(port, () => {
  console.log(`\n  SkyConnect Smart Flight Operations (Miami pilot prototype)`);
  console.log(`  Open http://localhost:${port}\n`);
});
