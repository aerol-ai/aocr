import { Header } from "@/components/header";
import { Hero } from "@/components/hero";
import { TokenAccess } from "@/components/token-access";
import { Features } from "@/components/features";
import { HowTo } from "@/components/how-to";
import { UseCases } from "@/components/use-cases";
import { TimeLimits } from "@/components/time-limits";
import { Footer } from "@/components/footer";

export default function Home() {
  return (
    <main className="min-h-screen bg-background">
      <Header />
      <Hero />
      <TokenAccess />
      <Features />
      <HowTo />
      <UseCases />
      <TimeLimits />
      <Footer />
    </main>
  );
}
