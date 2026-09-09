import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySession } from "@/lib/auth/session";
import { hydrateActor } from "@/lib/auth/actor";
import { ChatApp } from "./chat-app";

export default async function Page() {
  const store = await cookies();
  const actor = hydrateActor(verifySession(store.get(SESSION_COOKIE)?.value));
  if (!actor) redirect("/login");
  return <ChatApp actor={actor} />;
}
