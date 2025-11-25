import express from "express";
import { getRedisClient } from "../redisClient.js";

const HORARIO_REDIS_KEY = "chronos:horarios";

const router = express.Router();

router.post("/cargar-horario", async (req, res) => {
  const materias = req.body;

  if (!Array.isArray(materias) || materias.length === 0) {
    return res
      .status(400)
      .json({ error: "El formato del horario no es válido o está vacío" });
  }

  try {
    const client = getRedisClient();
    await client.json.set(HORARIO_REDIS_KEY, "$", materias);
    console.log("📥 Materias guardadas correctamente en Redis");

    res
      .status(200)
      .json({ message: "Materias guardadas en Redis correctamente" });
  } catch (err) {
    console.error("❌ Error al guardar en Redis:", err);
    res.status(500).json({ error: "Error al guardar los datos en Redis" });
  }
});

router.get("/cargar-horario", async (req, res) => {
  try {
    const client = getRedisClient();
    const data = await client.json.get(HORARIO_REDIS_KEY);

    if (!data) {
      return res
        .status(404)
        .json({ error: "No se encontraron materias cargadas" });
    }

    res.status(200).json(data);
  } catch (err) {
    console.error("❌ Error al leer desde Redis:", err);
    res.status(500).json({ error: "Error al recuperar los datos desde Redis" });
  }
});

export default router;
