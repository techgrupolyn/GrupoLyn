import { useEffect, useState } from 'react';
import { beginClubSso } from './club-sso';

export default function ClubSsoLogin() {
  const [error, setError] = useState('');
  useEffect(() => beginClubSso({ clubOrigin: import.meta.env.VITE_CLUB_LYN_SSO_ORIGIN || '', onError: setError }), []);
  return (
    <main className="min-h-screen flex items-center justify-center bg-neutral-950 text-white p-6">
      <section className="max-w-md space-y-4" aria-live="polite">
        <h1 className="text-xl font-semibold">Gestor de reuniones</h1>
        <p role={error ? 'alert' : 'status'}>{error || 'Validando tu sesión de Club LYN…'}</p>
        {error && <a className="underline" href="/?view=meetings">Acceder con usuario y contraseña</a>}
      </section>
    </main>
  );
}
