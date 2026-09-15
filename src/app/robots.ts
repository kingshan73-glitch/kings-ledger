import type { MetadataRoute } from "next";

/**
 * 검색엔진 전면 차단. (설계 146)
 * 이 앱은 개인 가계부라 공개 색인 대상이 하나도 없다. 로그인 페이지까지 포함해
 * 전 경로를 Disallow 한다. (2026-08-04 보안점검: robots.txt 가 아예 없어
 *  크롤러를 막는 장치가 0이었다. 색인된 페이지는 당시 0건.)
 *
 * 주의: middleware.ts 의 matcher 가 robots.txt 를 인증 가드에서 제외하고 있어야
 * 비로그인 크롤러가 이 파일을 받을 수 있다.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", disallow: "/" }],
  };
}
