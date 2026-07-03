import { useEffect, useState } from "react";
import { BrowserRouter, Route, Routes, useLocation } from "react-router-dom";
import { Header } from "./components/Header";
import { Footer } from "./components/Footer";
import { CityPicker } from "./components/CityPicker";
import { LandingPage } from "./pages/LandingPage";
import { CalendarPage } from "./pages/CalendarPage";
import { LoginPage } from "./pages/LoginPage";
import { ProfilePage } from "./pages/ProfilePage";
import { AuthProvider } from "./lib/auth";
import type { City } from "./lib/types";

const CITY_STORAGE_KEY = "nomad-city";
const THEME_STORAGE_KEY = "nomad-theme";

function loadStoredCity(): City | null {
  try {
    const raw = localStorage.getItem(CITY_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as City) : null;
  } catch {
    return null;
  }
}

function loadTheme(): "dark" | "light" {
  return localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark";
}

function Shell() {
  const [city, setCity] = useState<City | null>(loadStoredCity);
  const [cityPickerOpen, setCityPickerOpen] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">(loadTheme);
  const location = useLocation();

  useEffect(() => {
    document.documentElement.classList.toggle("light", theme === "light");
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  const pickCity = (c: City) => {
    setCity(c);
    localStorage.setItem(CITY_STORAGE_KEY, JSON.stringify(c));
    setCityPickerOpen(false);
  };

  const onCalendar = location.pathname === "/app";

  return (
    <div className="flex min-h-screen flex-col">
      <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-8">
        <Header
          city={city}
          theme={theme}
          onCityClick={() => setCityPickerOpen(true)}
          onThemeToggle={() =>
            setTheme((t) => (t === "dark" ? "light" : "dark"))
          }
        />

        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/app" element={<CalendarPage city={city} />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/profile" element={<ProfilePage />} />
        </Routes>
      </div>

      <Footer />

      <CityPicker
        open={cityPickerOpen || (onCalendar && city === null)}
        onPick={pickCity}
        onClose={city ? () => setCityPickerOpen(false) : undefined}
      />
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Shell />
      </BrowserRouter>
    </AuthProvider>
  );
}
