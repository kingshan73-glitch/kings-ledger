import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 개발 모드 좌하단의 Next.js 표시기(검정 N 버튼) 숨김. (개발 전용 UI, 배포본엔 원래 없음)
  devIndicators: false,
};

export default nextConfig;
