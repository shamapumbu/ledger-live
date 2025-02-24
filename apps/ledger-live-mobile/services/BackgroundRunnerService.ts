import { log } from "@ledgerhq/logs";
import { withDevicePolling } from "@ledgerhq/live-common/lib/hw/deviceAccess";
import getDeviceInfo from "@ledgerhq/live-common/lib/hw/getDeviceInfo";
import { from } from "rxjs";
import { timeout } from "rxjs/operators";
import { NativeModules } from "react-native";
import { hasFinalFirmware } from "@ledgerhq/live-common/lib/hw/hasFinalFirmware";
import { FirmwareUpdateContext } from "@ledgerhq/live-common/lib/types/manager";
import prepareFirmwareUpdate from "@ledgerhq/live-common/lib/hw/firmwareUpdate-prepare";
import mainFirmwareUpdate from "@ledgerhq/live-common/lib/hw/firmwareUpdate-main";

import { addBackgroundEvent } from "../src/actions/appstate";
import { store } from "../src/context/LedgerStore";
import { BackgroundEvent } from "../src/reducers/appstate";

const FIVE_MINUTES_IN_MS = 5 * 60 * 1000;

/**
 * This task is not able to touch UI, but it will allow us to complete tasks
 * even when the device goes to the background. We don't have access to hooks
 * because we are not inside a component but we can read/write the store so we'll
 * use that as the common-ground.
 */
const TAG = "headlessJS";
const BackgroundRunnerService = async ({
  deviceId,
  firmwareSerializedJson,
}: {
  deviceId: string;
  firmwareSerializedJson: string;
}) => {
  const emitEvent = (e: BackgroundEvent) =>
    store.dispatch(addBackgroundEvent(e));
  const latestFirmware = JSON.parse(firmwareSerializedJson) as
    | FirmwareUpdateContext
    | null
    | undefined;

  if (!latestFirmware) {
    log(TAG, "no need to update");
    return 0;
  }

  const onError = (error: any) => {
    emitEvent({ type: "error", error });
    NativeModules.BackgroundRunner.stop();
  };

  const onFirmwareUpdated = () => {
    emitEvent({ type: "firmwareUpdated" });
    NativeModules.BackgroundRunner.stop();
  };

  const waitForOnlineDevice = (maxWait: number) => {
    return withDevicePolling(deviceId)(
      transport => from(getDeviceInfo(transport)),
      () => true,
    ).pipe(timeout(maxWait));
  };

  prepareFirmwareUpdate(deviceId, latestFirmware).subscribe({
    next: ({ progress, displayedOnDevice }) => {
      if (displayedOnDevice) {
        emitEvent({ type: "confirmUpdate" });
      } else {
        emitEvent({ type: "downloadingUpdate", progress });
      }
    },
    error: onError,
    complete: () => {
      // Depending on the update path, we might need to run the firmwareMain or simply wait until
      // the device is online.
      if (
        latestFirmware.shouldFlashMCU ||
        hasFinalFirmware(latestFirmware.final)
      ) {
        emitEvent({ type: "flashingMcu" });
        mainFirmwareUpdate(deviceId, latestFirmware).subscribe({
          next: ({ progress, installing }) => {
            if (progress === 1 && installing === "flash-mcu") {
              // this is the point where we lose communication with the device until the update
              // is finished and the user has entered their PIN. Therefore the message here should
              // be generic about waiting for the firmware to finish and then entering the pin
              emitEvent({ type: "confirmPin" });
            } else {
              emitEvent({ type: "flashingMcu", progress, installing });
            }
          },
          error: onError,
          complete: () => {
            emitEvent({ type: "confirmPin" });
            waitForOnlineDevice(5 * 60 * 1000).subscribe({
              error: onError,
              complete: onFirmwareUpdated,
            });
          },
        });
      } else {
        emitEvent({ type: "confirmPin" });
        // We're waiting forever condition that make getDeviceInfo work
        waitForOnlineDevice(FIVE_MINUTES_IN_MS).subscribe({
          error: onError,
          complete: onFirmwareUpdated,
        });
      }
    },
  });

  return null;
};

export default BackgroundRunnerService;
