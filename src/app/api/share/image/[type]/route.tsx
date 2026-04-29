import { NextRequest } from "next/server";
import { publicConfig } from "@/config/public-config";
import {
  getShareImageResponse,
  parseNextRequestSearchParams,
} from "@/neynar-farcaster-sdk/nextjs";

// Cache for 1 hour - query strings create separate cache entries
export const revalidate = 3600;

const { appEnv, heroImageUrl, imageUrl } = publicConfig;

const showDevWarning = appEnv !== "production";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ type: string }> },
) {
  const { type } = await params;

  // Extract query params
  const searchParams = parseNextRequestSearchParams(request);
  const followingCount = searchParams.followingCount ?? "0";
  const balance = searchParams.balance ?? "0";
  const username = searchParams.username ?? "trader";

  return getShareImageResponse(
    { type, heroImageUrl, imageUrl, showDevWarning },
    // Portfolio-themed overlay with CopyTrade amber/gold branding
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        justifyContent: "flex-end",
        width: "100%",
        height: "100%",
        padding: 40,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 16,
          backgroundImage:
            "linear-gradient(135deg, rgba(200,168,75,0.15), rgba(13,13,10,0.9))",
          borderRadius: 24,
          padding: "32px 40px",
          border: "2px solid rgba(200,168,75,0.3)",
          boxShadow: "0 12px 48px rgba(0,0,0,0.5)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <div
            style={{
              display: "flex",
              fontSize: 14,
              fontWeight: "bold",
              textTransform: "uppercase",
              letterSpacing: 3,
              color: "#c8a84b",
            }}
          >
            COPYTRADE
          </div>
          <div
            style={{
              display: "flex",
              width: 8,
              height: 8,
              borderRadius: "50%",
              backgroundColor: "#c8a84b",
            }}
          />
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div
            style={{
              display: "flex",
              fontSize: 18,
              color: "rgba(255,255,255,0.6)",
            }}
          >
            @{username}&apos;s Portfolio
          </div>

          <div
            style={{
              display: "flex",
              fontSize: 52,
              fontWeight: "bold",
              color: "#c8a84b",
              lineHeight: 1,
            }}
          >
            ${parseFloat(balance).toLocaleString()}
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 20,
              marginTop: 8,
            }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              <div
                style={{
                  display: "flex",
                  fontSize: 12,
                  color: "rgba(255,255,255,0.4)",
                  textTransform: "uppercase",
                  letterSpacing: 1,
                }}
              >
                Copying
              </div>
              <div
                style={{
                  display: "flex",
                  fontSize: 28,
                  fontWeight: "bold",
                  color: "white",
                }}
              >
                {followingCount}
              </div>
            </div>

            <div
              style={{
                display: "flex",
                width: 1,
                height: 40,
                backgroundColor: "rgba(200,168,75,0.2)",
              }}
            />

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              <div
                style={{
                  display: "flex",
                  fontSize: 12,
                  color: "rgba(255,255,255,0.4)",
                  textTransform: "uppercase",
                  letterSpacing: 1,
                }}
              >
                Traders
              </div>
              <div
                style={{
                  display: "flex",
                  fontSize: 28,
                  fontWeight: "bold",
                  color: "white",
                }}
              >
                {followingCount === "0" ? "—" : followingCount}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>,
  );
}
