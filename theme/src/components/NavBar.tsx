"use client";

import LanguageSwitch from "./Language";
import LoginDialog from "./Login";
import ThemeSwitcher from "./ThemeSwitcher";
import { useTheme } from '@/contexts/ThemeContext';
import DarkModeToggle from "./DarkModeToggle";
import ResidualValueCalculator from "./ResidualValueCalculator";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { usePublicInfo } from "@/contexts/PublicInfoContext";
import { useNodeList } from "@/contexts/NodeListContext";
import { useTranslation } from "react-i18next";
import { Check, ChevronsUpDown, Server } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

const NavBar = () => {
  const { publicInfo } = usePublicInfo();
  const { themeConfig, showAssetCalculatorButton } = useTheme();
  const { t } = useTranslation();
  const pathname = usePathname() || "/";
  const { nodeList } = useNodeList();
  const pathParts = pathname.split("/").filter(Boolean);
  const currentUuid = pathParts[0] === "instance" ? pathParts[1] : undefined;
  const currentNode = nodeList?.find((node) => node.uuid === currentUuid);
  const sortedNodes = [...(nodeList || [])].sort((a, b) => a.weight - b.weight);

  return (
    <nav className="sticky top-0 z-50 w-full border-b bg-background/80 backdrop-blur-md supports-[backdrop-filter]:bg-background/60 transition-all duration-300 shadow-sm">
      <div className="container mx-auto flex h-16 md:h-20 items-center justify-between px-4">
        {/* Logo and Title */}
        <div className="flex items-center gap-2">
          <Link href="/" className="flex items-center gap-3 hover:opacity-80 transition-all">
            {themeConfig.logoImageUrl ? (
              <div className="h-8 w-8 rounded-lg overflow-hidden shadow-md ring-1 ring-black/8 bg-white/0">
                <img src={themeConfig.logoImageUrl} alt="logo" className="h-full w-full object-cover" />
              </div>
            ) : (
              <div className="h-8 w-8 bg-primary rounded-lg flex items-center justify-center shadow-md shadow-primary/20">
                <span className="text-primary-foreground font-bold text-xl">K</span>
              </div>
            )}
            <span className="text-xl md:text-2xl font-bold tracking-tight bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent">
              {publicInfo?.sitename}
            </span>
          </Link>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 min-h-9 shrink-0">
          {currentUuid ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  className="ds-nav-node-switch"
                  title={t("common.switchNode", { defaultValue: "切换节点" })}
                >
                  <Server className="h-4 w-4 shrink-0" />
                  <span className="ds-nav-node-switch-name">
                    {currentNode?.name || t("common.switchNode", { defaultValue: "切换节点" })}
                  </span>
                  <ChevronsUpDown className="h-4 w-4 shrink-0" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="ds-nav-node-menu">
                <DropdownMenuLabel>
                  {t("common.switchNode", { defaultValue: "切换节点" })}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {sortedNodes.map((node) => (
                  <DropdownMenuItem key={node.uuid} asChild>
                    <Link href={`/instance/${node.uuid}`} className="ds-nav-node-option">
                      <span className="ds-nav-node-region">{node.region || "🌐"}</span>
                      <span className="ds-nav-node-option-name">{node.name}</span>
                      {node.uuid === currentUuid ? <Check className="ml-auto h-4 w-4" /> : null}
                    </Link>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          {showAssetCalculatorButton ? <ResidualValueCalculator /> : null}
          <DarkModeToggle />
          <ThemeSwitcher />
          <LanguageSwitch />

          {publicInfo?.private_site ? (
            <LoginDialog
              autoOpen={publicInfo?.private_site}
              info={t('common.private_site')}
              onLoginSuccess={() => { window.location.reload(); }}
            />
          ) : (
            <LoginDialog />
          )}
        </div>
      </div>
    </nav>
  );
};

export default NavBar;
