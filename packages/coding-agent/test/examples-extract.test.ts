// 两个抽取器对着 fixtures/examples/ 的微型语料做字段级断言。fixture 里埋了两个
// "必须被跳过"的陷阱:esp-idf 的 common_components(共享代码不是例程)与 Cube 的
// Demonstrations(板专属大杂烩)。
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
	extractEspIdfExamples,
	extractStm32CubeExamples,
	parseComponentDeps,
	parseSupportedTargets,
} from "../src/core/examples/index.ts";

const ESP_ROOT = join(import.meta.dir, "fixtures", "examples", "esp-idf-mini");
const CUBE_ROOT = join(import.meta.dir, "fixtures", "examples", "cube-mini");

describe("esp-idf 抽取器", () => {
	const entries = extractEspIdfExamples(ESP_ROOT);
	const byPath = new Map(entries.map((entry) => [entry.path, entry]));

	test("收齐三个例程,common_components 被跳过", () => {
		expect(entries.map((entry) => entry.path)).toEqual([
			"examples/get-started/hello_world",
			"examples/peripherals/i2c/i2c_simple",
			"examples/protocols/mqtt/tcp",
		]);
	});

	test("mqtt 例程:targets 表 / 标题 / 摘要跳过样板句 / deps / configKeys / pytest / SPDX", () => {
		const mqtt = byPath.get("examples/protocols/mqtt/tcp");
		expect(mqtt?.targets).toEqual(["esp32", "esp32c3", "esp32s3"]);
		expect(mqtt?.title).toBe("ESP-MQTT sample application");
		expect(mqtt?.summary).toContain("connects to the broker");
		expect(mqtt?.summary?.startsWith("(See the README")).toBe(false);
		expect(mqtt?.deps).toEqual(["espressif/mqtt"]);
		expect(mqtt?.configKeys).toEqual(["CONFIG_BROKER_URL", "CONFIG_MQTT_PROTOCOL_5"]);
		expect(mqtt?.acceptance).toEqual({ kind: "pytest", path: "pytest_mqtt.py" });
		expect(mqtt?.peripherals).toContain("mqtt");
		expect(mqtt?.peripherals).toContain("nvs");
		expect(mqtt?.license).toBe("CC0-1.0");
		expect(mqtt?.buildNote).toContain("联网");
	});

	test("无 README 表的例程:targets 空 = 未知,不是不支持", () => {
		const hello = byPath.get("examples/get-started/hello_world");
		expect(hello?.targets).toEqual([]);
		expect(hello?.buildable).toBe(true);
	});

	test("路径段 + driver include 都进外设:i2c_master.h 归一成 i2c", () => {
		const i2c = byPath.get("examples/peripherals/i2c/i2c_simple");
		expect(i2c?.peripherals).toEqual(["i2c"]);
	});

	test("loc 只数 main/ 源码,确定性排序", () => {
		const mqtt = byPath.get("examples/protocols/mqtt/tcp");
		expect(mqtt?.loc).toBeGreaterThan(0);
		expect(extractEspIdfExamples(ESP_ROOT)).toEqual(entries);
	});
});

describe("esp-idf 解析细节", () => {
	test("Supported Targets 表:大小写与连字符归一", () => {
		expect(parseSupportedTargets("| Supported Targets | ESP32-C6 | ESP32-H2 |\n|---|---|")).toEqual([
			"esp32c6",
			"esp32h2",
		]);
	});

	test("idf_component.yml:跳过 idf 自身,嵌套块不误收", () => {
		expect(parseComponentDeps("dependencies:\n  espressif/led_strip: '^2'\n  idf:\n    version: '>=5'\n")).toEqual([
			"espressif/led_strip",
		]);
	});
});

describe("STM32Cube 抽取器", () => {
	const entries = extractStm32CubeExamples(CUBE_ROOT);
	const byPath = new Map(entries.map((entry) => [entry.path, entry]));

	test("收齐例程,Demonstrations 与 IDE 目录被跳过,BSP 直挂收组本身,清单 readme 不吞组", () => {
		expect(entries.map((entry) => entry.path)).toEqual([
			// BSP 直挂在类目下(有 Src):收它自己,不把 EWARM/MDK-ARM/Src 当例程(v1 真踩过)。
			"Projects/NUCLEO-F401RE/Examples/BSP",
			// GPIO 组里混着一个纯 IDE 目录(EWARM),没有工程结构证据,不收。
			"Projects/NUCLEO-F401RE/Examples/GPIO/GPIO_IOToggle",
			"Projects/NUCLEO-F401RE/Examples/I2C/I2C_TwoBoards_ComPolling",
			// SPI 组带清单式 readme:readme 单独不算工程,子例程照常收(真语料实测吞过整组)。
			"Projects/NUCLEO-F401RE/Examples/SPI/SPI_FullDuplex_ComDMA",
			"Projects/NUCLEO-F401RE/Examples/UART/UART_DualCore",
		]);
	});

	test("H7 式双核例程:CM7/Src 的源码计入 loc 与外设证据", () => {
		const dual = byPath.get("Projects/NUCLEO-F401RE/Examples/UART/UART_DualCore");
		expect(dual?.loc).toBeGreaterThan(0);
		expect(dual?.peripherals).toEqual(["uart"]);
	});

	test("gpio 例程:@page 标题 / @par 描述 / 板名 / 家族 / include+调用证据,conf 全家桶不算", () => {
		const gpio = byPath.get("Projects/NUCLEO-F401RE/Examples/GPIO/GPIO_IOToggle");
		expect(gpio?.title).toBe("GPIO IO Toggle example");
		expect(gpio?.summary).toContain("HAL API");
		expect(gpio?.board).toBe("NUCLEO-F401RE");
		expect(gpio?.targets).toEqual(["stm32f4"]);
		// gpio 来自组名+include+调用,rcc 来自 HAL_RCC_ 调用;conf.h 里枚举的 spi/can/cryp
		// 是模块开关清单,绝不能混进来 —— 真语料上它曾让每个例程挂 37 个外设。
		expect(gpio?.peripherals).toEqual(["gpio", "rcc"]);
		expect(gpio?.license).toBe("BSD-3-Clause");
	});

	test("i2c 例程:外设组 + 源码 include 合并(i2c 与 dma 都在)", () => {
		const i2c = byPath.get("Projects/NUCLEO-F401RE/Examples/I2C/I2C_TwoBoards_ComPolling");
		expect(i2c?.peripherals).toEqual(["dma", "i2c"]);
	});

	test("Drivers 实体 → buildable,备注讲清在包内构建", () => {
		for (const entry of entries) {
			expect(entry.buildable).toBe(true);
			expect(entry.buildNote).toContain("固件包");
		}
	});
});
