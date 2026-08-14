/**
 * The disclosure, in plain language, above the fold and never behind a
 * "learn more". Someone is about to hand us a credential that can spend their
 * money; they are owed a straight answer about where it goes before they do.
 */
export function VaultNote() {
  return (
    <p className="mt-3 rounded-xl bg-deep/60 p-4 text-sm leading-relaxed text-muted ring-1 ring-white/5">
      <strong className="font-display font-semibold text-starlight">
        Where your key lives.
      </strong>{" "}
      It's encrypted (AES-256-GCM) before it touches our database and is only
      ever decrypted in memory to make a request you asked for. It never appears
      in a response, a log, or a URL. Delete it here any time and the row is
      gone immediately. We never make a call you didn't click.
    </p>
  );
}
