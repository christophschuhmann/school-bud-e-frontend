import { Handlers } from "$fresh/server.ts";

// Definiert die Struktur der erwarteten Wikipedia-Suchergebnisse
interface WikipediaSearchResult {
  title: string;
  pageid: number;
}

// Definiert die Struktur der Seitendaten, die wir erhalten
interface WikipediaPage {
  pageid: number;
  title: string;
  extract: string;
}

export const handler: Handlers = {
  async POST(req: Request) {
    try {
      const { text, collection, n = 5 } = await req.json();

      if (!text) {
        return new Response(JSON.stringify({ error: "Text parameter is required" }), { status: 400 });
      }

      // Bestimme die Sprache basierend auf der 'collection'-Variable (für Abwärtskompatibilität)
      const lang = collection === "German-ConcatX-Abstract" ? "de" : "en";
      const WIKIPEDIA_API_URL = `https://${lang}.wikipedia.org/w/api.php`;

      // --- SCHRITT 1: Suche nach dem Begriff, um die besten Seitentitel zu finden ---
      const searchUrl = new URL(WIKIPEDIA_API_URL);
      searchUrl.searchParams.set("action", "query");
      searchUrl.searchParams.set("list", "search");
      searchUrl.searchParams.set("srsearch", text);
      searchUrl.searchParams.set("srlimit", String(n)); // Limitiere die Anzahl der Suchergebnisse
      searchUrl.searchParams.set("format", "json");

      const searchResponse = await fetch(searchUrl);
      if (!searchResponse.ok) {
        throw new Error(`Wikipedia search API error! status: ${searchResponse.status}`);
      }
      const searchData = await searchResponse.json();
      
      const searchResults: WikipediaSearchResult[] = searchData.query?.search;

      if (!searchResults || searchResults.length === 0) {
        return new Response(JSON.stringify([]), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // Sammle die Titel der besten Suchergebnisse
      const titles = searchResults.map(result => result.title).join("|");

      // --- SCHRITT 2: Hole die Zusammenfassungen (extracts) für die gefundenen Titel ---
      const extractUrl = new URL(WIKIPEDIA_API_URL);
      extractUrl.searchParams.set("action", "query");
      extractUrl.searchParams.set("prop", "extracts");
      extractUrl.searchParams.set("titles", titles);
      extractUrl.searchParams.set("exintro", "true");      // Nur die Einleitung
      extractUrl.searchParams.set("explaintext", "true"); // Als reinen Text, nicht HTML
      extractUrl.searchParams.set("format", "json");
      extractUrl.searchParams.set("redirects", "1"); // Folgt Weiterleitungen automatisch

      const extractResponse = await fetch(extractUrl);
      if (!extractResponse.ok) {
        throw new Error(`Wikipedia extract API error! status: ${extractResponse.status}`);
      }
      const extractData = await extractResponse.json();
      const pages: Record<string, WikipediaPage> = extractData.query?.pages;

      // --- SCHRITT 3: Formatiere die Ergebnisse für das Frontend ---
      const formattedResults = Object.values(pages).map(page => {
        // Erzeuge die URL zur Wikipedia-Seite
        const pageUrl = `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.title)}`;
        return {
          Title: page.title,
          URL: pageUrl,
          content: page.extract || "Keine Zusammenfassung verfügbar.", // Fallback
          score: "N/A" // Die offizielle API liefert keinen Score
        };
      });

      return new Response(JSON.stringify(formattedResults), {
        headers: { "Content-Type": "application/json" },
      });

    } catch (error) {
      console.error("Error in Wikipedia API handler:", error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  },
};