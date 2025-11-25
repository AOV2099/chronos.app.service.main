import express from "express";
import { getRedisClient } from "../redisClient.js";

const PROFESORES_REDIS_KEY = "chronos:profesores";

const router = express.Router();

router.post("/cargar-profesores", async (req, res) => {
  const profesores = req.body;

  if (!Array.isArray(profesores) || profesores.length === 0) {
    return res
      .status(400)
      .json({ error: "El formato del horario no es válido o está vacío" });
  }

  try {
    const client = getRedisClient();
    await client.json.set(PROFESORES_REDIS_KEY, "$", profesores);
    console.log("📥 profesores guardados correctamente en Redis");

    res
      .status(200)
      .json({ message: "profesores guardadas en Redis correctamente" });
  } catch (err) {
    console.error("❌ Error al guardar en Redis:", err);
    res.status(500).json({ error: "Error al guardar los datos en Redis" });
  }
});

router.get("/cargar-profesores", async (req, res) => {
  try {
    const client = getRedisClient();
    const data = await client.json.get(PROFESORES_REDIS_KEY);

    if (!data) {
      return res
        .status(404)
        .json({ error: "No se encontraron profesores cargados" });
    }

    res.status(200).json(data);
  } catch (err) {
    console.error("❌ Error al leer desde Redis:", err);
    res.status(500).json({ error: "Error al recuperar los datos desde Redis" });
  }
});

export default router;
