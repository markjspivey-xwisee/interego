// The workbench's views by route. Used by the app shell and by the workbench pane beside an orchestrated
// run, which renders the same views inside its own frame and route.
import { Home } from "./home.jsx";
import { Lexicon } from "./lexicon.jsx";
import { MapView } from "./map.jsx";
import { Compare } from "./compare.jsx";
import { Review } from "./review.jsx";
import { Packs } from "./packs.jsx";
import { Insights } from "./insights.jsx";
import { Agents } from "./agents.jsx";
import { Ask } from "./ask.jsx";
import { ForI2IDL } from "./fori2idl.jsx";
import { Annotate } from "./annotate.jsx";
import { Semantic } from "./semantic.jsx";
import { Icon } from "../icons.jsx";

export function ViewFor({ route, engine }) {
  switch (route.view) {
    case "lexicon": return <Lexicon route={route} />;
    case "map": return <MapView route={route} />;
    case "compare": return <Compare route={route} />;
    case "review": return <Review route={route} />;
    case "packs": return <Packs route={route} />;
    case "insights": return <Insights route={route} />;
    case "agents": return <Agents route={route} />;
    case "ask": return engine ? <Ask engine={engine} /> : <Elsewhere what="Ask Claude" />;
    case "fori2idl": return <ForI2IDL />;
    case "annotate": return <Annotate />;
    case "semantic": return <Semantic route={route} />;
    case "orchestrate": return <Elsewhere what="Orchestrate" />;
    default: return <Home />;
  }
}

function Elsewhere({ what }) {
  return (
    <div className="page" style={{ maxWidth: 560 }}>
      <div className="empty"><Icon name="info" /><div><b>{what} opens in the full workbench</b></div><div className="small">This frame shows what the agents work on.</div></div>
    </div>
  );
}
