import { Switch, Route, Router, Link, useLocation } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import NewAnalysis from "@/pages/NewAnalysis";
import AnalysisView from "@/pages/AnalysisView";
import History from "@/pages/History";
import Settings from "@/pages/Settings";
import NotFound from "@/pages/not-found";
import { PlusCircle, Clock, Settings as SettingsIcon } from "lucide-react";

// ── SVG Logo ─────────────────────────────────────────────────────────────────
function NashLogo({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Агент Нэша"
    >
      {/* Payoff matrix grid */}
      <rect x="2" y="2" width="13" height="13" rx="2" fill="hsl(38 92% 50% / 0.15)" stroke="hsl(38 92% 50%)" strokeWidth="1.5"/>
      <rect x="17" y="2" width="13" height="13" rx="2" fill="hsl(220 15% 16%)" stroke="hsl(220 15% 28%)" strokeWidth="1.5"/>
      <rect x="2" y="17" width="13" height="13" rx="2" fill="hsl(220 15% 16%)" stroke="hsl(220 15% 28%)" strokeWidth="1.5"/>
      <rect x="17" y="17" width="13" height="13" rx="2" fill="hsl(142 70% 45% / 0.12)" stroke="hsl(142 70% 45% / 0.5)" strokeWidth="1.5"/>
      {/* Nash equilibrium dot */}
      <circle cx="8.5" cy="8.5" r="2.5" fill="hsl(38 92% 50%)"/>
      <circle cx="23.5" cy="23.5" r="2.5" fill="hsl(142 70% 45%)"/>
    </svg>
  );
}

// ── Sidebar Navigation ────────────────────────────────────────────────────────
function Sidebar() {
  const [location] = useLocation();

  const navItems = [
    { href: "/", label: "Новый кейс", icon: PlusCircle },
    { href: "/history", label: "Все кейсы", icon: Clock },
    { href: "/settings", label: "Настройки", icon: SettingsIcon },
  ];

  return (
    <aside className="w-56 shrink-0 flex flex-col border-r border-sidebar-border bg-sidebar h-screen sticky top-0">
      {/* Brand */}
      <div className="flex items-center gap-2.5 px-4 py-4 border-b border-sidebar-border">
        <NashLogo size={28} />
        <div>
          <div className="text-sm font-bold text-foreground leading-tight">Агент Нэша</div>
          <div className="text-xs text-muted-foreground leading-tight">Теория игр в продукте</div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 p-2 space-y-0.5">
        {navItems.map(({ href, label, icon: Icon }) => {
          const isActive = href === "/" ? location === "/" : location.startsWith(href);
          return (
            <Link key={href} href={href}>
              <a
                className={`flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors cursor-pointer
                  ${isActive
                    ? "bg-primary/15 text-primary font-medium"
                    : "text-muted-foreground hover-elevate"
                  }`}
                data-testid={`nav-${href.replace("/", "") || "home"}`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                {label}
              </a>
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-sidebar-border">
        <a
          href="https://ru.wikipedia.org/wiki/%D0%9D%D1%8D%D1%88,_%D0%94%D0%B6%D0%BE%D0%BD_%D0%A4%D0%BE%D1%80%D0%B1%D1%81?ysclid=mobf7n0rc7252450983"
          target="_blank"
          rel="noreferrer"
          className="text-xs text-primary hover:text-primary/80 transition-colors"
        >
          John Forbes Nash
        </a>
      </div>
    </aside>
  );
}

// ── Root Layout ───────────────────────────────────────────────────────────────
function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar />
      <main className="flex-1 min-w-0 overflow-auto">
        {children}
      </main>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Router hook={useHashLocation}>
        <Layout>
          <Switch>
            <Route path="/" component={NewAnalysis} />
            <Route path="/analysis/:id" component={AnalysisView} />
            <Route path="/history" component={History} />
            <Route path="/settings" component={Settings} />
            <Route component={NotFound} />
          </Switch>
        </Layout>
      </Router>
      <Toaster />
    </QueryClientProvider>
  );
}
