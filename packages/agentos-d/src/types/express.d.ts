import type { Principal } from "../auth/principal.js";

declare global {
  namespace Express {
    interface Request {
      principal?: Principal;
    }
  }
}
