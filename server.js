import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { connectRedis, ensureJsonArrayKey } from "./src/redisClient.js";
import horarioRoutes from "./src/routes/horario.js";
import asignaturaRoutes from "./src/routes/asignatura.js";
import profesorRoutes from "./src/routes/profesores.js";
import horarioPdfRoutes from "./src/routes/horario-pdf.js";
import horarioGeneralRoutes from "./src/routes/horario-general.js";
import propuestaPdfRoutes from "./src/routes/propuesta-pdf.js";
import propuestaIndividual from "./src/routes/propuesta-pdf.js";

dotenv.config();

// 1) Conecta Redis
await connectRedis();

// 2) Asegura las claves necesarias **después** de conectar
await Promise.all([
  ensureJsonArrayKey("chronos:horarios"),
  ensureJsonArrayKey("chronos:materias"),
  ensureJsonArrayKey("chronos:profesores"),
]);

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.use("/api", horarioRoutes);
app.use("/api", asignaturaRoutes);
app.use("/api", profesorRoutes);
app.use("/api", horarioGeneralRoutes);
app.use("/api", horarioPdfRoutes);
app.use("/api", propuestaPdfRoutes);
app.use("/api", propuestaIndividual);

app.get("/", (_req, res) => {
  res.send("🧠 Servidor Express funcionando, Tony");
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en http://localhost:${PORT}`);
});
