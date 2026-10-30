import { Hono } from "hono";
import { readHome } from "../readers/home";

// Mounted at /api/home. GET / → the decision queue, the four status metrics and the agents (#18).
// Read only. Every row and metric carries its source; "could not read" is reported, not hidden.
const home = new Hono();

home.get("/", async (c) => c.json(await readHome()));

export default home;
