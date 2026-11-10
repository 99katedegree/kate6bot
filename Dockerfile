FROM denoland/deno:2.9.8

WORKDIR /app

COPY deno.json deno.lock ./
COPY src ./src
COPY migrations ./migrations

RUN deno cache src/main.ts

CMD ["deno", "task", "start"]
