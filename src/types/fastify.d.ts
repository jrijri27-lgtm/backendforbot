import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    user?: {
      id: string;
      telegramId: bigint;
      username: string | null;
      isBanned: boolean;
      isAdmin: boolean;
    };
  }
}
