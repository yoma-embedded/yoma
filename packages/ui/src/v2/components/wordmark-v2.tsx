import { createUniqueId, type ComponentProps } from "solid-js"

export function WordmarkV2(props: Pick<ComponentProps<"svg">, "class">) {
  const filter = createUniqueId()
  const mask = createUniqueId()
  const maskGradient = createUniqueId()

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 720.002 129.001"
      fill="none"
      preserveAspectRatio="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      {/* "yoma" wordmark, centered in the original 720×129 box — same blocky pixel style as the opencode mark */}
      <g opacity="0.2" filter={`url(#${filter})`} mask={`url(#${mask})`}>
        <path opacity="0.7" d="M175.386 18.4297H193.8475V36.8583H175.386ZM230.7705 18.4297H249.232V36.8583H230.7705ZM175.386 36.8583H193.8475V55.2868H175.386ZM230.7705 36.8583H249.232V55.2868H230.7705ZM175.386 55.2868H193.8475V73.7154H175.386ZM193.8475 55.2868H212.309V73.7154H193.8475ZM212.309 55.2868H230.7705V73.7154H212.309ZM230.7705 55.2868H249.232V73.7154H230.7705ZM230.7705 73.7154H249.232V92.144H230.7705ZM193.8475 92.144H212.309V110.573H193.8475ZM212.309 92.144H230.7705V110.573H212.309ZM230.7705 92.144H249.232V110.573H230.7705Z" fill="currentColor" />
        <path opacity="0.7" d="M267.6935 18.4297H286.155V36.8583H267.6935ZM286.155 18.4297H304.6165V36.8583H286.155ZM304.6165 18.4297H323.078V36.8583H304.6165ZM323.078 18.4297H341.5395V36.8583H323.078ZM267.6935 36.8583H286.155V55.2868H267.6935ZM323.078 36.8583H341.5395V55.2868H323.078ZM267.6935 55.2868H286.155V73.7154H267.6935ZM323.078 55.2868H341.5395V73.7154H323.078ZM267.6935 73.7154H286.155V92.144H267.6935ZM323.078 73.7154H341.5395V92.144H323.078ZM267.6935 92.144H286.155V110.573H267.6935ZM286.155 92.144H304.6165V110.573H286.155ZM304.6165 92.144H323.078V110.573H304.6165ZM323.078 92.144H341.5395V110.573H323.078Z" fill="currentColor" />
        <path opacity="0.7" d="M360.001 18.4297H378.4625V36.8583H360.001ZM378.4625 18.4297H396.924V36.8583H378.4625ZM396.924 18.4297H415.3855V36.8583H396.924ZM415.3855 18.4297H433.847V36.8583H415.3855ZM433.847 18.4297H452.3085V36.8583H433.847ZM360.001 36.8583H378.4625V55.2868H360.001ZM396.924 36.8583H415.3855V55.2868H396.924ZM433.847 36.8583H452.3085V55.2868H433.847ZM360.001 55.2868H378.4625V73.7154H360.001ZM396.924 55.2868H415.3855V73.7154H396.924ZM433.847 55.2868H452.3085V73.7154H433.847ZM360.001 73.7154H378.4625V92.144H360.001ZM396.924 73.7154H415.3855V92.144H396.924ZM433.847 73.7154H452.3085V92.144H433.847ZM360.001 92.144H378.4625V110.573H360.001ZM396.924 92.144H415.3855V110.573H396.924ZM433.847 92.144H452.3085V110.573H433.847Z" fill="currentColor" />
        <path opacity="0.7" d="M470.77 18.4297H489.2315V36.8583H470.77ZM489.2315 18.4297H507.693V36.8583H489.2315ZM507.693 18.4297H526.1545V36.8583H507.693ZM526.1545 18.4297H544.616V36.8583H526.1545ZM526.1545 36.8583H544.616V55.2868H526.1545ZM470.77 55.2868H489.2315V73.7154H470.77ZM489.2315 55.2868H507.693V73.7154H489.2315ZM507.693 55.2868H526.1545V73.7154H507.693ZM526.1545 55.2868H544.616V73.7154H526.1545ZM470.77 73.7154H489.2315V92.144H470.77ZM526.1545 73.7154H544.616V92.144H526.1545ZM470.77 92.144H489.2315V110.573H470.77ZM489.2315 92.144H507.693V110.573H489.2315ZM507.693 92.144H526.1545V110.573H507.693ZM526.1545 92.144H544.616V110.573H526.1545Z" fill="currentColor" />
      </g>
      <defs>
        <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="720" height="129">
          <rect width="720" height="129" fill={`url(#${maskGradient})`} />
        </mask>
        <linearGradient id={maskGradient} x1="360" y1="0" x2="360" y2="129" gradientUnits="userSpaceOnUse">
          <stop stop-color="white" stop-opacity="0.85" />
          <stop offset="1" stop-color="white" stop-opacity="0.2" />
        </linearGradient>
        <filter
          id={filter}
          x="0"
          y="0"
          width="720.002"
          height="130.001"
          filterUnits="userSpaceOnUse"
          color-interpolation-filters="sRGB"
        >
          <feFlood flood-opacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset dy="1" />
          <feGaussianBlur stdDeviation="1" />
          <feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1" />
          <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0" />
          <feBlend mode="normal" in2="shape" result="effect1_innerShadow_4938_16028" />
        </filter>
      </defs>
    </svg>
  )
}
