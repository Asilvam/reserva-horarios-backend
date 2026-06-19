# --- STAGE 1: Build ---
FROM node:22-alpine AS builder
WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./

# Instalar todas las dependencias (incluyendo las de desarrollo para compilar TS)
RUN npm ci

# Copiar el resto del código fuente
COPY . .

# Compilar el proyecto NestJS a JavaScript nativo (genera la carpeta /dist)
RUN npm run build

# --- STAGE 2: Production ---
FROM node:22-alpine AS runner
WORKDIR /app

# Configurar entorno de producción
ENV NODE_ENV=production

# Copiar package.json y package-lock.json
COPY package*.json ./

# Instalar SOLO las dependencias de producción (reduce tamaño)
RUN npm ci --only=production

# Copiar la carpeta compilada desde el stage de compilación
COPY --from=builder /app/dist ./dist

# Exponer el puerto por defecto que usa NestJS o Fly (normalmente 3000 o 8080)
EXPOSE 3000

# Comando para arrancar la aplicación
CMD ["node", "dist/main.js"]