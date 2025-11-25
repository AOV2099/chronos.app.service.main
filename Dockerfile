FROM node:20-alpine

WORKDIR /app

# Copiamos package.json / package-lock.json (si existe)
COPY package*.json ./

# Instalar dependencias del backend
# (archiver, express, pdfkit, redis, etc. son puros JS)
RUN npm install

# Copiamos el resto del código del backend
COPY . .

ENV NODE_ENV=production

# Puerto del backend
EXPOSE 3000

# Comando de inicio
CMD ["node", "server.js"]
