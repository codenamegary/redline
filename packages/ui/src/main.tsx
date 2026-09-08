import { QueryClientProvider } from "@tanstack/react-query"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter, Route, Routes } from "react-router"
import { createQueryClient } from "./app/query.client"
import { GalleryPage } from "./features/gallery/GalleryPage"
import { ReviewPage } from "./features/review/ReviewPage"
import { SettingsPage } from "./features/settings/SettingsPage"
import "./index.css"

const queryClient = createQueryClient()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<GalleryPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/a/:id" element={<ReviewPage />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
