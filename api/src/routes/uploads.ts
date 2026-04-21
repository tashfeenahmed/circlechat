import { FastifyInstance } from "fastify";
import { putObject, publicUrl } from "../lib/storage.js";
import { requireAuth } from "../auth/session.js";
import { id } from "../lib/ids.js";

export default async function uploadRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.post("/uploads", async (req, reply) => {
    const data = await req.file();
    if (!data) return reply.code(400).send({ error: "no_file" });
    const buf = await data.toBuffer();
    const safeName = data.filename.replace(/[^a-z0-9._-]/gi, "_");
    const key = `u/${id("f").slice(2)}/${safeName}`;
    await putObject(key, buf);
    return {
      key,
      name: data.filename,
      contentType: data.mimetype,
      size: buf.length,
      url: publicUrl(key),
    };
  });
}
