import Header from "../islands/Header.tsx";
import ChatAgreementOrIsland from "../islands/ChatAgreementOrIsland.tsx";

export default function Home(req: Request) {
  const url = new URL(req.url);
  const lang = url.searchParams.get("lang") as string !== undefined &&
      url.searchParams.get("lang") !== null
    ? url.searchParams.get("lang")
    : "de";

  return (
    <div
      class="px-4 py-8 w-full"
      style={{
        backgroundImage: "url('/lines.svg')",
        backgroundPosition: "center",
        backgroundSize: "cover",
        backgroundRepeat: "no-repeat",
        minHeight: "100dvh",
      }}
    >
      <div class="w-full max-w-screen-lg px-1 sm:px-2 mx-auto flex flex-col items-center justify-center">
        <Header lang={lang as string} />
        <ChatAgreementOrIsland lang={lang as string} />
      </div>
    </div>
  );   // <- return-Klammer schließen

}     // <- und auch die Funktions-Klammer schließen!
