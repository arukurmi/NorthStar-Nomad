export function Footer() {
  return (
    <footer className="mt-16 border-t border-raise/60 py-6">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-2 px-4 text-xs text-muted sm:flex-row sm:justify-between sm:px-8">
        <p>© {new Date().getFullYear()} Northstar Nomad</p>
        <p>
          Made with <span aria-label="love">❤️</span> in Bangalore
        </p>
        <a
          href="https://arukurmi.vercel.app/#contact"
          target="_blank"
          rel="noreferrer"
          className="transition hover:text-starlight"
        >
          Contact the developer ↗
        </a>
      </div>
    </footer>
  );
}
