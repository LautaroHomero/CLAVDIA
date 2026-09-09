import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySession } from "@/lib/auth/session";
import { ChatApp } from "./chat-app";

export default async function Page() {
  const store = await cookies();
  const actor = verifySession(store.get(SESSION_COOKIE)?.value);
  if (!actor) redirect("/login");
  return <ChatApp actor={actor} />;
}
