import { IInputs, IOutputs } from "./generated/ManifestTypes";

export class DevProxySample implements ComponentFramework.StandardControl<IInputs, IOutputs> {
    private container!: HTMLDivElement;
    private shell!: HTMLDivElement;
    private status!: HTMLDivElement;
    private input!: HTMLInputElement;
    private notifyOutputChanged!: () => void;
    private currentValue = "";

    /**
     * Used to initialize the control instance. Controls can kick off remote server calls and other initialization actions here.
     * Data-set values are not initialized here, use updateView.
     * @param context The entire property bag available to control via Context Object; It contains values as set up by the customizer mapped to property names defined in the manifest, as well as utility functions.
     * @param notifyOutputChanged A callback method to alert the framework that the control has new outputs ready to be retrieved asynchronously.
     * @param state A piece of data that persists in one session for a single user. Can be set at any point in a controls life cycle by calling 'setControlState' in the Mode interface.
     * @param container If a control is marked control-type='standard', it will receive an empty div element within which it can render its content.
     */
    public init(
        context: ComponentFramework.Context<IInputs>,
        notifyOutputChanged: () => void,
        state: ComponentFramework.Dictionary,
        container: HTMLDivElement
    ): void {
        console.log("[DevProxySample] init called");

        this.container = container;
        this.notifyOutputChanged = notifyOutputChanged;
        this.currentValue = context.parameters.sampleProperty.raw ?? "";

        this.shell = document.createElement("div");
        this.shell.style.padding = "10px";
        this.shell.style.borderRadius = "8px";
        this.shell.style.border = "2px solid #2d7d46";
        this.shell.style.background = "linear-gradient(135deg, #e9f6ec 0%, #f5fbf7 100%)";

        this.status = document.createElement("div");
        this.status.textContent = "HMR Active: v17 - you blinked, you missed it!";
        this.status.style.fontFamily = "'Segoe UI', Tahoma, sans-serif";
        this.status.style.fontSize = "12px";
        this.status.style.fontWeight = "600";
        this.status.style.color = "#1f5f35";
        this.status.style.marginBottom = "8px";

        this.input = document.createElement("input");
        this.input.type = "text";
        this.input.value = this.currentValue;
        this.input.placeholder = "Type here - no full page reload needed";
        this.input.style.width = "100%";
        this.input.style.boxSizing = "border-box";
        this.input.style.padding = "8px";
        this.input.style.border = "2px solid #2d7d46";
        this.input.style.borderRadius = "4px";
        this.input.style.fontSize = "14px";
        this.input.style.fontFamily = "'Segoe UI', Tahoma, sans-serif";

        this.input.addEventListener("input", this.onInput);
        this.shell.appendChild(this.status);
        this.shell.appendChild(this.input);
        this.container.appendChild(this.shell);

        void state;
    }


    /**
     * Called when any value in the property bag has changed. This includes field values, data-sets, global values such as container height and width, offline status, control metadata values such as label, visible, etc.
     * @param context The entire property bag available to control via Context Object; It contains values as set up by the customizer mapped to names defined in the manifest, as well as utility functions
     */
    public updateView(context: ComponentFramework.Context<IInputs>): void {
        const incoming = context.parameters.sampleProperty.raw ?? "";
        if (incoming !== this.currentValue) {
            this.currentValue = incoming;
            this.input.value = incoming;
        }

        this.input.disabled = context.mode.isControlDisabled;
    }

    /**
     * It is called by the framework prior to a control receiving new data.
     * @returns an object based on nomenclature defined in manifest, expecting object[s] for property marked as "bound" or "output"
     */
    public getOutputs(): IOutputs {
        return {
            sampleProperty: this.currentValue,
        };
    }

    /**
     * Called when the control is to be removed from the DOM tree. Controls should use this call for cleanup.
     * i.e. cancelling any pending remote calls, removing listeners, etc.
     */
    public destroy(): void {
        if (this.input) {
            this.input.removeEventListener("input", this.onInput);
        }
    }

    private onInput = (event: Event): void => {
        const nextValue = (event.target as HTMLInputElement).value;
        if (nextValue === this.currentValue) return;
        this.currentValue = nextValue;
        this.notifyOutputChanged();
    };
}
