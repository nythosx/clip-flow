import { Routes, Route } from "react-router-dom";
import Layout from "./components/Layout";
import Home from "./pages/Home";
import ProjectDetail from "./pages/ProjectDetail";
import TemplateList from "./pages/TemplateList";
import TemplateEditor from "./pages/TemplateEditor";
import Accounts from "./pages/Accounts";
import AccountDetail from "./pages/AccountDetail";
import Queue from "./pages/Queue";
import Settings from "./pages/Settings";
import Legal from "./pages/Legal";
import YouTubeImport from "./pages/YouTubeImport";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Home />} />
        <Route path="/projects/:id" element={<ProjectDetail />} />
        <Route path="/templates" element={<TemplateList />} />
        <Route path="/templates/:id" element={<TemplateEditor />} />
        <Route path="/accounts" element={<Accounts />} />
        <Route path="/accounts/:id" element={<AccountDetail />} />
        <Route path="/youtube" element={<YouTubeImport />} />
        <Route path="/queue" element={<Queue />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/legal" element={<Legal />} />
      </Route>
    </Routes>
  );
}
